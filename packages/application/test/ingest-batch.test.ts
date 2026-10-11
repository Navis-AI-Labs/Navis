import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  eventEnvelopeSchema,
  ProjectStateKernel,
  serializeProjectionStateRecord,
  type StateEvent,
} from '@navis/domain';
import { parseCanonicalWorkEventPayload } from '@navis/contracts';
import { InMemoryEventStore } from '@navis/infrastructure';

import { ingestBatch, type IngestEventInput } from '../src/index.js';

/**
 * The use case at unit distance from the wire: every scenario in the ingest
 * contract is exercised directly against the in-memory ledger, so the
 * semantics the route promises are pinned at their own layer (standard 02).
 */

const PROJECT = '01924a61-7a1b-7c2d-8e3f-000000000001';
const OTHER_PROJECT = '01924a61-7a1b-7c2d-8e3f-000000000002';
const DEVICE = '01924a61-7a1b-7c2d-8e3f-0000000000a1';
const OTHER_DEVICE = '01924a61-7a1b-7c2d-8e3f-0000000000a2';
const AT = '2026-09-01T00:00:00.000Z';

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `01924a61-7a1b-7c2d-8e3f-${idCounter.toString(16).padStart(12, '0')}`;
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    occurred_at: AT,
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

function input(overrides: Record<string, unknown> = {}): IngestEventInput {
  return { event_id: nextId(), event: event(overrides), ...overrides };
}

function hashOf(e: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(e)).digest('hex');
}

function run(events: readonly IngestEventInput[], options: { verifyHash?: boolean } = {}) {
  const eventStore = new InMemoryEventStore();
  return ingestBatch(
    {
      eventStore,
      verifyPayloadHash: options.verifyHash ?? false,
      now: () => AT,
    },
    { deviceId: DEVICE, events },
  );
}

describe('ingestBatch', () => {
  it('appends a well-formed batch and reports every event accepted', async () => {
    const a = input();
    const b = input();
    const res = await run([a, b]);

    expect(res.projectId).toBe(PROJECT);
    expect(res.accepted).toEqual([0, 1]);
    expect(res.rejected).toEqual([]);
    expect(res.duplicate).toEqual([]);
  });

  it('writes envelopes with the ledger convention and the dedup pair', async () => {
    const a = input();
    const eventStore = new InMemoryEventStore();
    await ingestBatch(
      { eventStore, verifyPayloadHash: false, now: () => AT },
      { deviceId: DEVICE, events: [a] },
    );

    const stored = await eventStore.loadEvents(PROJECT, 1);
    expect(stored.length).toBe(1);
    expect(stored[0]?.event_id).toBe(a.event_id);
    expect(stored[0]?.aggregate_type).toBe('project');
    expect(stored[0]?.aggregate_id).toBe(PROJECT);
    expect(stored[0]?.idempotency_key).toBe(`${DEVICE}:${a.event_id}`);
    expect(stored[0]?.privacy_class).toBe('work');
    expect(stored[0]?.recorded_at).toBe(AT);
    expect(stored[0]?.metadata['device_id']).toBe(DEVICE);
  });

  it('maps session-internal types to the audit privacy class', async () => {
    const a = input({
      event_type: 'user.message',
      payload: { privacy: { char_length: 10, sha256: 'a'.repeat(64) } },
    });
    const eventStore = new InMemoryEventStore();
    await ingestBatch(
      { eventStore, verifyPayloadHash: false, now: () => AT },
      { deviceId: DEVICE, events: [a] },
    );

    const stored = await eventStore.loadEvents(PROJECT, 1);
    expect(stored[0]?.privacy_class).toBe('audit');
  });

  it('maps evidence.captured to the evidence privacy class', async () => {
    const a = input({ event_type: 'evidence.captured', payload: { raw_ref: 'file:///t.log' } });
    const eventStore = new InMemoryEventStore();
    await ingestBatch(
      { eventStore, verifyPayloadHash: false, now: () => AT },
      { deviceId: DEVICE, events: [a] },
    );

    const stored = await eventStore.loadEvents(PROJECT, 1);
    expect(stored[0]?.privacy_class).toBe('evidence');
  });

  it('rides the wrapper causation link onto the envelope', async () => {
    const cause = nextId();
    const a = input();
    const eventStore = new InMemoryEventStore();
    await ingestBatch(
      { eventStore, verifyPayloadHash: false, now: () => AT },
      { deviceId: DEVICE, events: [{ ...a, causation_id: cause }] },
    );

    const stored = await eventStore.loadEvents(PROJECT, 1);
    expect(stored[0]?.causation_id).toBe(cause);
  });

  it('treats a re-send of the same batch as duplicate', async () => {
    const eventStore = new InMemoryEventStore();
    const deps = { eventStore, verifyPayloadHash: false, now: () => AT };
    const a = input();
    await ingestBatch(deps, { deviceId: DEVICE, events: [a] });

    const res = await ingestBatch(deps, { deviceId: DEVICE, events: [a] });
    expect(res.accepted).toEqual([]);
    expect(res.duplicate).toEqual([0]);
    expect((await eventStore.loadEvents(PROJECT, 1)).length).toBe(1);
  });

  it('acknowledges the duplicate and accepts the new event in one batch', async () => {
    const eventStore = new InMemoryEventStore();
    const deps = { eventStore, verifyPayloadHash: false, now: () => AT };
    const a = input();
    const b = input();
    await ingestBatch(deps, { deviceId: DEVICE, events: [a] });

    const res = await ingestBatch(deps, { deviceId: DEVICE, events: [a, b] });
    expect(res.accepted).toEqual([1]);
    expect(res.duplicate).toEqual([0]);
    expect((await eventStore.loadEvents(PROJECT, 1)).length).toBe(2);
  });

  it('treats the same event id twice inside one batch as a duplicate', async () => {
    const a = input();
    const res = await run([a, { ...a }]);

    expect(res.accepted).toEqual([0]);
    expect(res.duplicate).toEqual([1]);
  });

  it('rejects a malformed event and appends its siblings', async () => {
    const good = input();
    const bad = input({ confidence: 'not-a-number' });
    const res = await run([good, bad]);

    expect(res.accepted).toEqual([0]);
    expect(res.rejected.length).toBe(1);
    expect(res.rejected[0]?.index).toBe(1);
    expect(res.rejected[0]?.token).toBe('ingest/schema-violation');
    expect(res.rejected[0]?.path).toContain('/events/1/event/');
  });

  it('rejects an unsupported schema version per event', async () => {
    const future = input({ schema_version: 2 });
    const res = await run([future]);

    expect(res.accepted).toEqual([]);
    expect(res.rejected[0]?.token).toBe('ingest/schema-version-unsupported');
    expect(res.rejected[0]?.path).toBe('/events/0/event/schema_version');
  });

  it('propagates an unexpected parser failure instead of swallowing it', async () => {
    // A field that throws on read makes the schema fail with something other
    // than a zod error — the batch must surface it, not mislabel it.
    const batch = input();
    Object.defineProperty(batch.event as Record<string, unknown>, 'occurred_at', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });

    await expect(run([batch])).rejects.toThrow('boom');
  });

  it('refuses a mismatched payload hash when verification is enabled', async () => {
    const a = input();
    const res = await run(
      [{ ...a, payload_hash: { algorithm: 'sha256', value: 'a'.repeat(64) } }],
      { verifyHash: true },
    );

    expect(res.accepted).toEqual([]);
    expect(res.rejected[0]?.token).toBe('ingest/payload-hash-mismatch');
    expect(res.rejected[0]?.path).toBe('/events/0/payload_hash');
  });

  it('accepts a matching payload hash when verification is enabled', async () => {
    const a = input();
    const res = await run(
      [
        {
          ...a,
          payload_hash: { algorithm: 'sha256', value: hashOf(a.event as Record<string, unknown>) },
        },
      ],
      { verifyHash: true },
    );

    expect(res.accepted).toEqual([0]);
  });

  it('skips payload verification entirely when the switch is off', async () => {
    const a = input();
    const res = await run(
      [{ ...a, payload_hash: { algorithm: 'sha256', value: 'a'.repeat(64) } }],
      { verifyHash: false },
    );

    expect(res.accepted).toEqual([0]);
  });

  it('rejects an event that belongs to another project', async () => {
    const local = input();
    const foreign = input({ project_id: OTHER_PROJECT });
    const res = await run([local, foreign]);

    expect(res.accepted).toEqual([0]);
    expect(res.rejected[0]?.index).toBe(1);
    expect(res.rejected[0]?.token).toBe('ingest/authorization-denied');
  });

  it('rejects an event id already owned by another device', async () => {
    const eventStore = new InMemoryEventStore();
    const deps = { eventStore, verifyPayloadHash: false, now: () => AT };
    const a = input();
    await ingestBatch(deps, { deviceId: OTHER_DEVICE, events: [a] });

    const res = await ingestBatch(deps, { deviceId: DEVICE, events: [a] });
    expect(res.accepted).toEqual([]);
    expect(res.duplicate).toEqual([]);
    expect(res.rejected[0]?.token).toBe('ingest/ledger-conflict');
  });

  it('appends starting at the head seq, preserving ledger order', async () => {
    const eventStore = new InMemoryEventStore();
    const deps = { eventStore, verifyPayloadHash: false, now: () => AT };
    const a = input();
    const b = input();
    const c = input();
    await ingestBatch(deps, { deviceId: DEVICE, events: [a] });
    await ingestBatch(deps, { deviceId: DEVICE, events: [b, c] });

    const stored = await eventStore.loadEvents(PROJECT, 1);
    expect(stored.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(stored.map((e) => e.event_id)).toEqual([a.event_id, b.event_id, c.event_id]);
  });

  it('reports no project when every event failed validation', async () => {
    const bad = input({ confidence: 'nope' });
    const res = await run([bad]);

    expect(res.projectId).toBe(null);
    expect(res.accepted).toEqual([]);
    expect(res.rejected.length).toBe(1);
  });

  it('emits one ordered result per batch index', async () => {
    const a = input();
    const bad = input({ confidence: 'nope' });
    const res = await run([a, bad]);

    expect(res.event_results.map((r) => [r.index, r.outcome])).toEqual([
      [0, 'accepted'],
      [1, 'rejected'],
    ]);
  });
});

it('records observations at the current ledger version when a snapshot is older', async () => {
  const k = new ProjectStateKernel();
  const actor = nextId();
  k.registerParticipant({ participant_id: actor, type: 'human', at: AT });
  const project = k.createProject({ actor, at: AT, title: 'version fixture', expected_version: 0 });
  if (!project.ok) throw new Error('fixture failed');
  const projectId = project.value.id;
  const store = new InMemoryEventStore();
  const envelope = (e: StateEvent) =>
    eventEnvelopeSchema.parse({
      event_id: nextId(),
      project_id: projectId,
      seq: e.seq,
      aggregate_type: 'project',
      aggregate_id: projectId,
      aggregate_revision: e.seq,
      event_type: e.type,
      event_schema_version: e.schema_version,
      occurred_at: e.at,
      recorded_at: e.at,
      actor_participant_id: e.actor,
      payload: e.data,
      metadata: {},
      privacy_class: 'audit',
      state_version: e.state_version,
    });
  await store.append(projectId, k.events.map(envelope), 0);
  await store.saveSnapshot(projectId, {
    seq: k.currentSeq,
    state_version: 0,
    schema_version: 1,
    state: serializeProjectionStateRecord(k.projection),
  });
  const before = k.currentSeq;
  k.updateBoundary({
    actor,
    at: AT,
    reason: 'new requirement',
    boundary: 'new scope',
    expected_version: 0,
  });
  await store.append(projectId, k.events.filter((e) => e.seq > before).map(envelope), before);
  await ingestBatch(
    { eventStore: store, verifyPayloadHash: false, now: () => AT },
    {
      deviceId: DEVICE,
      events: [input({ project_id: projectId })],
    },
  );
  const stored = await store.loadEvents(projectId, 0);
  expect(stored.at(-1)?.state_version).toBe(1);
  const replayed = ProjectStateKernel.fromEvents(
    stored.map((e) => ({
      seq: e.seq,
      type: e.event_type,
      data: e.payload,
      actor: e.actor_participant_id,
      at: e.occurred_at,
      state_version: e.state_version,
      schema_version: e.event_schema_version,
    })),
    undefined,
    parseCanonicalWorkEventPayload,
  );
  expect(replayed.stateVersion).toBe(1);
  expect(replayed.verifyIntegrity()).toEqual({ ok: true });
});

it('refuses capture under the current project policy without losing per-event rejection coverage', async () => {
  const store = new InMemoryEventStore();
  const good = input();
  const result = await ingestBatch(
    {
      eventStore: store,
      now: () => AT,
      verifyPayloadHash: false,
      canCapture: () => Promise.resolve(false),
    },
    { deviceId: DEVICE, events: [good, { ...good }, input({ event: { invalid: true } })] },
  );
  expect(result.accepted).toEqual([]);
  expect(result.duplicate).toEqual([]);
  expect(result.rejected).toHaveLength(3);
  expect(result.event_results).toHaveLength(3);
  expect(await store.headSeq(PROJECT)).toBe(0);
});
