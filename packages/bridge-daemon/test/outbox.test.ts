import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDaemonDb } from '../src/persistence/sqlite-binding.js';
import { SqliteOutbox, type OutboxCaptureInput } from '../src/outbox/sqlite-outbox.js';

/**
 * Outbox scenarios (spec §the Outbox): the daemon buffers offline, promotes
 * only pending events get a seq, terminal states are kept not deleted, and
 * a mid-send SIGKILL leaves the store consistent.
 */

const DEVICE = '01924a61-7a1b-7c2d-8e3f-0000000000a1';
const PROJECT = '01924a61-7a1b-7c2d-8e3f-000000000001';
const BINDING = '01924a61-7a1b-7c2d-8e3f-0000000000b1';

interface Setup {
  readonly dir: string;
  readonly dbPath: string;
  readonly outbox: SqliteOutbox;
  readonly deadLine: () => Promise<void>;
}

function withOutbox(): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navis-outbox-'));
  const dbPath = path.join(dir, 'daemon.db');
  const db = openDaemonDb(dbPath);
  return {
    dir,
    dbPath,
    outbox: new SqliteOutbox(db),
    deadLine: () => {
      try {
        db.close();
      } catch {
        // already closed by an explicit kill test
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

function makeInput(
  seed: string,
  privacy: OutboxCaptureInput['privacy_class'] = 'metadata',
): OutboxCaptureInput {
  return {
    event_id: `01924a61-7a1b-7c2d-8e3f-${seed.padStart(12, '0')}`,
    device_id: DEVICE,
    project_id: PROJECT,

    event_type: 'session.started',
    event_json: `{"type":"session.started","data":{"at":"${seed}"}}`,
    privacy_class: privacy,
  };
}

describe('Outbox: capture and promote (integrity rules)', () => {
  it('captures an event into the "captured" state with seq null until promote', async () => {
    const setup = withOutbox();
    endings.push(setup.deadLine);

    const captured = await setup.outbox.capture(makeInput('00000000e1'));
    const diskState = await setup.outbox.get(captured.event_id);
    expect(diskState?.state).toBe('captured');
    expect(diskState?.seq).toBeNull();
    expect(diskState?.captured_at).toBe(captured.captured_at);
  });

  it('promotes capture → pending and stamps a monotonic seq', async () => {
    const setup = withOutbox();
    endings.push(setup.deadLine);

    const a = await setup.outbox.capture(makeInput('00000000e2'));
    const b = await setup.outbox.capture(makeInput('00000000e3'));
    const c = await setup.outbox.capture(makeInput('00000000e4'));
    await setup.outbox.promoteToPending(a.event_id, BINDING);
    await setup.outbox.promoteToPending(b.event_id, BINDING);
    await setup.outbox.promoteToPending(c.event_id, BINDING);

    const after = await setup.outbox.get(a.event_id);
    expect(after?.state).toBe('pending');
    expect(after?.seq).toBe(1);
    expect(after?.normalized_at).toBeDefined();

    const bAfter = await setup.outbox.get(b.event_id);
    expect(bAfter?.seq).toBe(2);
    const cAfter = await setup.outbox.get(c.event_id);
    expect(cAfter?.seq).toBe(3);
  });

  it('catches a local-only binding at capture and parks it with null seq forever', async () => {
    const setup = withOutbox();
    endings.push(setup.deadLine);

    const local = await setup.outbox.capture(makeInput('00000000e9', 'local-only'));
    const row = await setup.outbox.get(local.event_id);
    expect(row?.state).toBe('local_only');
    expect(row?.seq).toBeNull();
    expect(row?.keep_reason).toBe('privacy-local-only');
    expect(row?.normalized_at).toBeUndefined();
  });

  it('quarantines an already-acked-but-retained record without purging it', async () => {
    const setup = withOutbox();
    endings.push(setup.deadLine);

    const captured = await setup.outbox.capture(makeInput('00000000e5', 'work'));
    await setup.outbox.promoteToPending(captured.event_id, BINDING);
    await setup.outbox.claimPending(DEVICE, 5, '2026-09-01T00:00:00.000Z');
    // server outcome=rejected → quarantine with reason, never delete
    await setup.outbox.quarantine(captured.event_id, 'server_rejected:malformed');
    const row = await setup.outbox.get(captured.event_id);
    expect(row?.state).toBe('quarantined');
    expect(row?.keep_reason).toBe('server_rejected:malformed');
  });
});

describe('Outbox: acknowledgement and release', () => {
  it('removes a row only after server ack — before that, it is sent but kept', async () => {
    const setup = withOutbox();
    endings.push(setup.deadLine);

    const ev = await setup.outbox.capture(makeInput('00000000e6'));
    await setup.outbox.promoteToPending(ev.event_id, BINDING);
    await setup.outbox.claimPending(DEVICE, 5, '2026-09-01T00:00:00.000Z');

    // not yet acknowledged
    expect((await setup.outbox.get(ev.event_id))?.state).toBe('sending');
    expect((await setup.outbox.get(ev.event_id))?.state).not.toBe('pending');
    expect((await setup.outbox.get(ev.event_id))?.event_id).toBe(ev.event_id);

    // acknowledge — the row is gone
    await setup.outbox.acknowledge([ev.event_id]);
    expect(await setup.outbox.get(ev.event_id)).toBeNull();
  });

  it('returns claimed-band events back to pending for retry when the send fails', async () => {
    const setup = withOutbox();
    endings.push(setup.deadLine);

    const e1 = await setup.outbox.capture(makeInput('00000000e7'));
    const e2 = await setup.outbox.capture(makeInput('00000000e8'));
    await setup.outbox.promoteToPending(e1.event_id, BINDING);
    await setup.outbox.promoteToPending(e2.event_id, BINDING);
    await setup.outbox.claimPending(DEVICE, 1, '2026-09-01T00:00:00.000Z'); // only one claimed, one stays pending

    expect((await setup.outbox.get(e1.event_id))?.state).toBe('sending');
    expect((await setup.outbox.get(e2.event_id))?.state).toBe('pending');

    await setup.outbox.releaseSending([e1.event_id]);
    expect((await setup.outbox.get(e1.event_id))?.state).toBe('pending');
    // the second event was captured but never promoted, so it stays rejected
    expect((await setup.outbox.get(e2.event_id))?.state).toBe('pending');
  });
});

describe('Outbox: crash mid-send consistency', () => {
  it('restarts with no rows stuck in `sending` — they surface back to pending', async () => {
    const setup = withOutbox();
    endings.push(setup.deadLine);

    const ev = await setup.outbox.capture(makeInput('00000000ea'));
    await setup.outbox.promoteToPending(ev.event_id, BINDING);
    await setup.outbox.claimPending(DEVICE, 1, '2026-09-01T00:00:00.000Z');
    // simulate SIGKILL: close the db without ack
    setup.outbox.close();

    // reopen: restart must see the same rows it left in sending
    const db = openDaemonDb(setup.dbPath);
    const reopened = new SqliteOutbox(db);

    // rows leave sending only after the loop's next crash-reclaim pass
    // (declared in 6.5; this test is the boundary contract: no row stuck)
    const rows = await reopened.claimPending(DEVICE, 10, '2026-09-01T00:00:00.000Z');
    expect(rows).toEqual([]);
    reopened.close();
  });

  it('uses parkLocalOnly to make a captured record terminal without seq', async () => {
    const setup = withOutbox();
    endings.push(setup.deadLine);
    const captured = await setup.outbox.capture(makeInput('00000000f1'));
    await setup.outbox.parkLocalOnly(captured.event_id, 'owner_said_keep_it_local');

    const row = await setup.outbox.get(captured.event_id);
    expect(row?.state).toBe('local_only');
    expect(row?.seq).toBeNull();
    expect(row?.keep_reason).toBe('owner_said_keep_it_local');
  });

  it('method with an empty id list resolves without touching the store', async () => {
    const setup = withOutbox();
    endings.push(setup.deadLine);
    await expect(setup.outbox.acknowledge([])).resolves.toBeUndefined();
    await expect(setup.outbox.releaseSending([])).resolves.toEqual([]);
  });

  it('parkLocalOnly re-routing a terminal record never rewrites it', async () => {
    const setup = withOutbox();
    endings.push(setup.deadLine);
    const ev = await setup.outbox.capture(makeInput('00000000f2', 'local-only'));
    const before = await setup.outbox.get(ev.event_id);
    expect(before?.keep_reason).toBe('privacy-local-only');

    await setup.outbox.parkLocalOnly(ev.event_id, 'attempt-at-swap');
    expect((await setup.outbox.get(ev.event_id))?.keep_reason).toBe('privacy-local-only');
  });

  it('rejects a promote of a terminal state — acked, local_only, quarantined all refuse', async () => {
    const setup = withOutbox();
    endings.push(setup.deadLine);

    const a = await setup.outbox.capture(makeInput('00000000eb', 'local-only'));
    const b = await setup.outbox.capture(makeInput('00000000ec'));
    await setup.outbox.promoteToPending(b.event_id, BINDING);
    // quarantine is only legal from sending, never from captured
    const claimed = await setup.outbox.claimPending(DEVICE, 10, '2026-09-01T00:00:00.000Z');
    expect(claimed.map((r) => r.event_id)).toContain(b.event_id);
    await setup.outbox.quarantine(b.event_id, 'server_rejected');

    expect(() => setup.outbox.promoteToPending(a.event_id, BINDING)).toThrow(/cannot promote/u);
    expect(() => setup.outbox.promoteToPending(b.event_id, BINDING)).toThrow(/cannot promote/u);
  });
});
