import { createHash } from 'node:crypto';
import { request } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalWorkEventSchemaVersion, ingestContractSchemaVersion } from '@navis/contracts';
import { canonicalJson } from '@navis/domain';
import { InMemoryEventStore } from '@navis/infrastructure';

import { loadApiConfig } from '../src/platform/config.js';
import { ingestRoute } from '../src/ingest/route.js';
import { createApiServer, type ApiServer, type ServiceRoute } from '../src/platform/server.js';
import type { LogSink } from '../src/platform/logging.js';

/**
 * End-to-end against a real `node:http` listener: the ingest contract is a
 * wire promise, so the batch scenarios are observed at the wire (standard 02).
 * The ledger behind the route is the in-memory adapter — the transport is what
 * is under test, not the storage engine.
 */

const PROJECT = '01924a61-7a1b-7c2d-8e3f-000000000001';
const OTHER_PROJECT = '01924a61-7a1b-7c2d-8e3f-000000000002';
const DEVICE = '01924a61-7a1b-7c2d-8e3f-0000000000a1';
const OTHER_DEVICE = '01924a61-7a1b-7c2d-8e3f-0000000000a2';
const FIXED_NOW = '2026-09-01T00:00:00.000Z';

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `01924a61-7a1b-7c2d-8e3f-${idCounter.toString(16).padStart(12, '0')}`;
}

function canonicalEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: canonicalWorkEventSchemaVersion,
    occurred_at: FIXED_NOW,
    project_id: PROJECT,
    source_runtime: 'test-runtime',
    source_session_id: 'session-1',
    raw_ref: 'file:///transcript.log',
    extractor_version: '0.1.0',
    confidence: 0.5,
    review_status: 'pending',
    event_type: 'work.started',
    payload: { work_id: nextId() },
    ...overrides,
  };
}

function oneEvent(eventOverrides: Record<string, unknown> = {}): {
  event_id: string;
  event: Record<string, unknown>;
} {
  return { event_id: nextId(), event: canonicalEvent(eventOverrides) };
}

function batch(
  events: readonly Record<string, unknown>[],
  device: string = DEVICE,
): Record<string, unknown> {
  return {
    contract_version: ingestContractSchemaVersion,
    event_schema_version: canonicalWorkEventSchemaVersion,
    device_id: device,
    events: [...events],
  };
}

interface Response {
  readonly status: number;
  readonly body: unknown;
}

/** A live listener plus the ledger behind it, shared across one scenario. */
interface Ledger {
  readonly eventStore: InMemoryEventStore;
  post(body: unknown): Promise<Response>;
}

const started: ApiServer[] = [];

async function openLedger(options: { verifyPayloadHash?: boolean } = {}): Promise<Ledger> {
  const eventStore = new InMemoryEventStore();
  const sink: LogSink = {
    write() {
      /* the transport is under test, not the log shape */
    },
  };
  const routes: readonly ServiceRoute[] = [
    ingestRoute({
      eventStore,
      verifyPayloadHash: options.verifyPayloadHash ?? false,
      now: () => FIXED_NOW,
    }),
  ];
  const server = createApiServer(loadApiConfig({}), sink, routes);
  started.push(server);
  const port = await server.listen(0, '127.0.0.1');

  const post = (body: unknown): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const serialized = JSON.stringify(body);
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/ingest',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(serialized).toString(),
            connection: 'close',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode ?? 0,
              body: raw.length === 0 ? undefined : JSON.parse(raw),
            });
          });
        },
      );
      req.on('error', reject);
      req.write(serialized);
      req.end();
    });

  return { eventStore, post };
}

function dataOf(body: unknown): Record<string, unknown> {
  const envelope = body as { data?: Record<string, unknown> } | undefined;
  return envelope?.data ?? {};
}

function rejectionsOf(body: unknown): readonly Record<string, unknown>[] {
  return dataOf(body)['rejected'] as readonly Record<string, unknown>[];
}

function sha256Of(event: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex');
}

afterEach(async () => {
  const pending = started.splice(0);
  for (const server of pending) {
    await server.close();
  }
});

describe('POST /api/ingest', () => {
  it('accepts a well-formed batch and appends the events', async () => {
    const ledger = await openLedger();
    const a = oneEvent();
    const b = oneEvent();
    const res = await ledger.post(batch([a, b]));

    expect(res.status).toBe(200);
    expect(dataOf(res.body)).toEqual({
      contract_version: ingestContractSchemaVersion,
      accepted: [0, 1],
      rejected: [],
      duplicate: [],
      event_results: [
        { index: 0, outcome: 'accepted' },
        { index: 1, outcome: 'accepted' },
      ],
      server_supported_contract_versions: [ingestContractSchemaVersion],
      server_supported_event_schema_versions: [canonicalWorkEventSchemaVersion],
    });

    const stored = await ledger.eventStore.loadEvents(PROJECT, 1);
    expect(stored.length).toBe(2);
    expect(stored[0]?.event_id).toBe(a.event_id);
    expect(stored[1]?.event_id).toBe(b.event_id);
    expect(stored[0]?.seq).toBe(1);
    expect(stored[1]?.seq).toBe(2);
    expect(stored[0]?.privacy_class).toBe('work');
    expect(stored[0]?.recorded_at).toBe(FIXED_NOW);
    expect(stored[0]?.idempotency_key).toBe(`${DEVICE}:${a.event_id}`);
  });

  it('acknowledges a duplicate-only batch as a no-op', async () => {
    const ledger = await openLedger();
    const event = oneEvent();
    const first = await ledger.post(batch([event]));
    expect(first.status).toBe(200);

    const res = await ledger.post(batch([event]));
    expect(res.status).toBe(200);
    expect(dataOf(res.body)).toEqual({
      contract_version: ingestContractSchemaVersion,
      accepted: [],
      rejected: [],
      duplicate: [0],
      event_results: [{ index: 0, outcome: 'duplicate' }],
      server_supported_contract_versions: [ingestContractSchemaVersion],
      server_supported_event_schema_versions: [canonicalWorkEventSchemaVersion],
    });
    expect((await ledger.eventStore.loadEvents(PROJECT, 1)).length).toBe(1);
  });

  it('accepts the new events in a mixed duplicate and new batch', async () => {
    const ledger = await openLedger();
    const a = oneEvent();
    const b = oneEvent();
    await ledger.post(batch([a]));

    const res = await ledger.post(batch([a, b]));
    expect(res.status).toBe(200);
    expect(dataOf(res.body)).toEqual({
      contract_version: ingestContractSchemaVersion,
      accepted: [1],
      rejected: [],
      duplicate: [0],
      event_results: [
        { index: 0, outcome: 'duplicate' },
        { index: 1, outcome: 'accepted' },
      ],
      server_supported_contract_versions: [ingestContractSchemaVersion],
      server_supported_event_schema_versions: [canonicalWorkEventSchemaVersion],
    });
    const stored = await ledger.eventStore.loadEvents(PROJECT, 1);
    expect(stored.length).toBe(2);
    expect(stored[1]?.event_id).toBe(b.event_id);
    expect(stored[1]?.seq).toBe(2);
  });

  it('rejects a malformed sibling without failing the batch', async () => {
    const ledger = await openLedger();
    const good = oneEvent();
    const malformed = {
      event_id: nextId(),
      event: canonicalEvent({ confidence: 'not-a-number' }),
    };
    const res = await ledger.post(batch([good, malformed, good]));

    expect(res.status).toBe(200);
    const data = dataOf(res.body);
    expect(data['accepted']).toEqual([0]);
    expect(data['duplicate']).toEqual([2]);
    expect(rejectionsOf(res.body).length).toBe(1);
    const rejection = rejectionsOf(res.body)[0];
    expect(rejection?.['index']).toBe(1);
    expect(rejection?.['token']).toBe('ingest/schema-violation');
  });

  it('rejects an unsupported schema version per event', async () => {
    const ledger = await openLedger();
    const future = {
      event_id: nextId(),
      event: canonicalEvent({ schema_version: 2 }),
    };
    const res = await ledger.post(batch([future]));

    expect(res.status).toBe(200);
    expect(dataOf(res.body)['accepted']).toEqual([]);
    expect(rejectionsOf(res.body).length).toBe(1);
    const rejection = rejectionsOf(res.body)[0];
    expect(rejection?.['index']).toBe(0);
    expect(rejection?.['token']).toBe('ingest/schema-version-unsupported');
  });

  it('rejects a tampered payload hash when verification is enabled', async () => {
    const ledger = await openLedger({ verifyPayloadHash: true });
    const event = oneEvent();
    const withClaim = {
      ...event,
      payload_hash: { algorithm: 'sha256' as const, value: 'a'.repeat(64) },
    };
    const res = await ledger.post(batch([withClaim]));

    expect(res.status).toBe(200);
    expect(dataOf(res.body)['accepted']).toEqual([]);
    expect(rejectionsOf(res.body).length).toBe(1);
    const rejection = rejectionsOf(res.body)[0];
    expect(rejection?.['token']).toBe('ingest/payload-hash-mismatch');
  });

  it('accepts a matching payload hash when verification is enabled', async () => {
    const ledger = await openLedger({ verifyPayloadHash: true });
    const event = oneEvent();
    const withClaim = {
      ...event,
      payload_hash: { algorithm: 'sha256' as const, value: sha256Of(event.event) },
    };
    const res = await ledger.post(batch([withClaim]));

    expect(res.status).toBe(200);
    expect(dataOf(res.body)['accepted']).toEqual([0]);
  });

  it('refuses an unsupported contract version before interpreting any event', async () => {
    const ledger = await openLedger();
    const body = batch([oneEvent()]);
    body['contract_version'] = 99;

    const res = await ledger.post(body);
    expect(res.status).toBe(400);
    const problem = res.body as Record<string, unknown>;
    expect(problem['code']).toBe('UNSUPPORTED_CONTRACT_VERSION');
    expect(problem['server_supported_contract_versions']).toEqual([ingestContractSchemaVersion]);
  });

  it('rejects an event from another project', async () => {
    const ledger = await openLedger();
    const local = oneEvent();
    const foreign = oneEvent({ project_id: OTHER_PROJECT });
    const res = await ledger.post(batch([local, foreign]));

    expect(res.status).toBe(200);
    expect(dataOf(res.body)['accepted']).toEqual([0]);
    const rejection = rejectionsOf(res.body)[0];
    expect(rejection?.['index']).toBe(1);
    expect(rejection?.['token']).toBe('ingest/authorization-denied');
  });

  it('rejects an event id that belongs to another device', async () => {
    const ledger = await openLedger();
    const event = oneEvent();
    await ledger.post(batch([event], OTHER_DEVICE));

    const res = await ledger.post(batch([event]));
    expect(res.status).toBe(200);
    expect(dataOf(res.body)['accepted']).toEqual([]);
    expect(dataOf(res.body)['duplicate']).toEqual([]);
    const rejection = rejectionsOf(res.body)[0];
    expect(rejection?.['index']).toBe(0);
    expect(rejection?.['token']).toBe('ingest/ledger-conflict');
  });

  it('rejects a malformed request body', async () => {
    const ledger = await openLedger();
    const res = await ledger.post({ device_id: DEVICE });
    expect(res.status).toBe(400);
    const problem = res.body as Record<string, unknown>;
    expect(problem['code']).toBe('BAD_REQUEST');
  });
});
