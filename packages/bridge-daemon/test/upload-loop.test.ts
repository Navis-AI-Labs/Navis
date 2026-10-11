import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDaemonDb } from '../src/persistence/sqlite-binding.js';
import { SqliteOutbox, type OutboxCaptureInput } from '../src/outbox/sqlite-outbox.js';
import { tick } from '../src/outbox/upload-loop.js';

/**
 * Outbox upload loop: claim up to 50 pending rows per tick,
 * send, split per-event answers into ack / reject / transport failure.
 * ack deletes the row; reject quarantines with the server-supplied reason;
 * failure releases back to pending with exponential backoff that gates the
 * next claim until it expires.
 */

const NOW = '2026-09-01T00:00:00.000Z';
const DEVICE = '01924a61-7a1b-7c2d-8e3f-0000000000a1';
const PROJECT = '01924a61-7a1b-7c2d-8e3f-000000000001';
const BINDING = '01924a61-7a1b-7c2d-8e3f-0000000000b1';

interface Setup {
  readonly outbox: SqliteOutbox;
  readonly deadLine: () => Promise<void>;
}

function withLoop(at: string = NOW): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navis-loop-'));
  const db = openDaemonDb(path.join(dir, 'daemon.db'));
  const outbox = new SqliteOutbox(db, () => at);
  return {
    outbox,
    deadLine: () => {
      try {
        db.close();
      } catch {
        /* test closed the db itself */
      }
      return Promise.resolve();
    },
  };
}

const endings: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (endings.length > 0) {
    const end = endings.pop();
    if (end !== undefined) await end();
  }
});

function makeInput(seed: string): OutboxCaptureInput {
  return {
    event_id: `01924a61-7a1b-7c2d-8e3f-${seed.padStart(12, '0')}`,
    device_id: DEVICE,
    project_id: PROJECT,
    event_type: 'session.started',
    event_json: `{"type":"session.started","data":{"seed":"${seed}"}}`,
    privacy_class: 'metadata',
  };
}

function receipt(outcomes: readonly ('accepted' | 'duplicate' | 'rejected')[]): string {
  const event_results = outcomes.map((outcome, index) => ({
    index,
    outcome,
    ...(outcome === 'rejected' ? { rejection: { index, token: 'ingest/schema-violation' } } : {}),
  }));
  return JSON.stringify({
    data: {
      contract_version: 1,
      accepted: event_results.filter((r) => r.outcome === 'accepted').map((r) => r.index),
      duplicate: event_results.filter((r) => r.outcome === 'duplicate').map((r) => r.index),
      rejected: event_results.filter((r) => r.outcome === 'rejected').map((r) => r.rejection),
      event_results,
      server_supported_contract_versions: [1],
      server_supported_event_schema_versions: [1],
    },
  });
}

describe('upload loop', () => {
  it('claims 50 rows and acks all of them — outbox ends empty', async () => {
    const setup = withLoop();
    endings.push(setup.deadLine);
    for (let i = 0; i < 50; i++) {
      const ev = await setup.outbox.capture(makeInput(`f${String(i).padStart(3, '0')}`));
      await setup.outbox.promoteToPending(ev.event_id, BINDING);
    }

    const sender = {
      send: (batch: readonly { event_id: string }[]) =>
        Promise.resolve({
          status: 200,
          body: receipt(batch.map(() => 'accepted')),
        }),
    };
    const slice = await tick(setup.outbox, sender, DEVICE, NOW);

    expect(slice.ackedCount).toBe(50);
    expect(await setup.outbox.get(slice.claimed[0]?.event_id ?? '')).toBeNull();
    expect((await setup.outbox.claimPending(DEVICE, 50, NOW)).length).toBe(0);
  });

  it('releases to pending with exponential backoff after a transport failure', async () => {
    const setup = withLoop();
    endings.push(setup.deadLine);

    const ev = await setup.outbox.capture(makeInput('a1b1c2d3'));
    await setup.outbox.promoteToPending(ev.event_id, BINDING);

    const sender = { send: () => Promise.resolve({ status: 500, body: 'gateway down' }) };
    await tick(setup.outbox, sender, DEVICE, NOW);

    const row = await setup.outbox.get(ev.event_id);
    expect(row?.retry_count).toBe(1);
    expect(row?.retry_after).toBe('2026-09-01T00:00:01.000Z');

    // backoff pins the row until expiry — the same-tick claim sees nothing
    expect((await setup.outbox.claimPending(DEVICE, 50, NOW)).length).toBe(0);
    const later = await setup.outbox.claimPending(DEVICE, 50, '2026-09-01T00:00:01.500Z');
    expect(later[0]?.event_id).toBe(ev.event_id);
  });

  it('quarantines rejected events with the server-supplied reason', async () => {
    const setup = withLoop();
    endings.push(setup.deadLine);

    const accepted = await setup.outbox.capture(makeInput('received-aaa'));
    const rejected = await setup.outbox.capture(makeInput('received-bbb'));
    await setup.outbox.promoteToPending(accepted.event_id, BINDING);
    await setup.outbox.promoteToPending(rejected.event_id, BINDING);

    const sender = {
      send: () =>
        Promise.resolve({
          status: 200,
          body: receipt(['accepted', 'rejected']),
        }),
    };
    await tick(setup.outbox, sender, DEVICE, NOW);

    expect(await setup.outbox.get(accepted.event_id)).toBeNull();
    const kept = await setup.outbox.get(rejected.event_id);
    expect(kept?.state).toBe('quarantined');
    expect(kept?.keep_reason).toBe('ingest/schema-violation');
  });

  it('does not contact the sender when there are zero pending rows', async () => {
    const setup = withLoop();
    endings.push(setup.deadLine);

    const slice = await tick(
      setup.outbox,
      {
        send: () => {
          throw new Error('must-never-be-called');
        },
      },
      DEVICE,
      NOW,
    );
    expect(slice.claimed.length).toBe(0);
    expect(slice.ackedCount).toBe(0);
    expect(slice.error).toBeUndefined();
  });

  it('releases with backoff when the sender throws (transport exception)', async () => {
    const setup = withLoop();
    endings.push(setup.deadLine);

    const ev = await setup.outbox.capture(makeInput('throw00001'));
    await setup.outbox.promoteToPending(ev.event_id, BINDING);

    const sender = { send: () => Promise.reject(new Error('socket reset')) };
    const slice = await tick(setup.outbox, sender, DEVICE, NOW);

    expect(slice.ackedCount).toBe(0);
    expect(slice.error).toBe('socket reset');
    const row = await setup.outbox.get(ev.event_id);
    expect(row?.state).toBe('pending');
    expect(row?.retry_count).toBe(1);
  });

  it('treats a 2xx with a malformed body as transport failure and backs off', async () => {
    const setup = withLoop();
    endings.push(setup.deadLine);

    const ev = await setup.outbox.capture(makeInput('garbage001'));
    await setup.outbox.promoteToPending(ev.event_id, BINDING);

    // non-JSON body
    let sender = { send: () => Promise.resolve({ status: 200, body: '<<not-json>>' }) };
    await tick(setup.outbox, sender, DEVICE, NOW);
    let row = await setup.outbox.get(ev.event_id);
    expect(row?.state).toBe('pending');
    expect(row?.retry_count).toBe(1);

    // JSON but results is not an array
    sender = { send: () => Promise.resolve({ status: 200, body: '{"results":"nope"}' }) };
    await tick(setup.outbox, sender, DEVICE, '2026-09-01T00:00:02.000Z');
    row = await setup.outbox.get(ev.event_id);
    expect(row?.retry_count).toBe(2);

    // A structurally invalid receipt must retain every row for bounded retry.
    sender = {
      send: () =>
        Promise.resolve({
          status: 200,
          body: JSON.stringify({ results: [{ event_id: 42 }, null, 'weird'] }),
        }),
    };
    await tick(setup.outbox, sender, DEVICE, '2026-09-01T00:00:03.000Z');
    // Invalid receipts do not strand claims in sending or delete captured data.
    row = await setup.outbox.get(ev.event_id);
    expect(row?.state).toBe('pending');
    expect(row?.retry_count).toBe(3);
  });

  it('increments retry_count on each failed tick', async () => {
    const setup = withLoop();
    endings.push(setup.deadLine);

    const ev = await setup.outbox.capture(makeInput('fffffff1'));
    await setup.outbox.promoteToPending(ev.event_id, BINDING);

    const sender = { send: () => Promise.resolve({ status: 500, body: 'down' }) };
    const counts: number[] = [];
    // advance the clock past each backoff so the row is claimable again
    for (let step = 0; step < 3; step++) {
      await tick(setup.outbox, sender, DEVICE, `2026-09-01T00:0${String(step)}:00.000Z`);
      counts.push((await setup.outbox.get(ev.event_id))?.retry_count ?? 0);
    }
    expect(counts).toEqual([1, 2, 3]);
  });
});
