import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  eventEnvelopeSchema,
  ProjectStateKernel,
  serializeProjectionStateRecord,
  uuidv7,
  type EventEnvelope,
  type EventStore,
  type KernelProjection,
} from '@navis/domain';
import {
  InMemoryEventStore,
  PostgresEventStore,
  createConnection,
  runMigrations,
} from '@navis/infrastructure';
import { captureSnapshotIfDue } from '../src/capture/capture-flow.js';

const AT = '2026-01-01T00:00:00.000Z';
const HUMAN = '01900000-0000-7000-8000-000000000001';
const atDay = (n: number): string => new Date(Date.parse(AT) + n * 86_400_000).toISOString();

function must<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('capture fixture command failed');
  return result.value;
}

function kernel(window = 4): ProjectStateKernel {
  const k = new ProjectStateKernel();
  must(k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT }));
  must(
    k.createProject({ actor: HUMAN, at: AT, title: 'merchant onboarding', expected_version: 0 }),
  );
  must(
    k.updatePolicy({
      actor: HUMAN,
      at: AT,
      reason: 'capture policy',
      event_count_window: window,
      expected_version: 0,
    }),
  );
  must(
    k.createAsset({
      actor: HUMAN,
      at: AT,
      kind: 'artifact',
      scope: 'project',
      content: { media_type: 'text/plain', storage: 'inline', sha256: 'a'.repeat(64) },
      expected_version: 0,
    }),
  );
  return k;
}

function projectId(k: ProjectStateKernel): string {
  const id = k.projection.project?.id;
  if (id === undefined) throw new Error('capture fixture project missing');
  return id;
}

async function persist(
  store: EventStore,
  k: ProjectStateKernel,
  fromSeq = 0,
): Promise<readonly EventEnvelope[]> {
  const id = projectId(k);
  const events = k.events
    .filter((e) => e.seq > fromSeq)
    .map((e) =>
      eventEnvelopeSchema.parse({
        event_id: uuidv7(),
        project_id: id,
        seq: e.seq,
        aggregate_type: 'project',
        aggregate_id: id,
        aggregate_revision: e.seq,
        event_type: e.type,
        event_schema_version: e.schema_version,
        occurred_at: e.at,
        recorded_at: e.at,
        actor_participant_id: e.actor ?? null,
        payload: e.data,
        metadata: {},
        privacy_class: 'audit',
        state_version: e.state_version,
      }),
    );
  await store.append(id, events, fromSeq);
  return store.loadEvents(id, 0);
}

function observeStore(store: EventStore, failSaveOnce = false) {
  const order: string[] = [];
  const inserted: number[][] = [];
  const port: EventStore = {
    append: (...args) => store.append(...args),
    loadEvents: (...args) => store.loadEvents(...args),
    loadSnapshot: (...args) => store.loadSnapshot(...args),
    markRetention: async (...args) => {
      order.push('mark');
      const rows = await store.markRetention(...args);
      inserted.push([...rows]);
      return rows;
    },
    saveSnapshot: async (...args) => {
      order.push('save');
      if (failSaveOnce) {
        failSaveOnce = false;
        throw new Error('injected snapshot failure');
      }
      await store.saveSnapshot(...args);
    },
  };
  return { port, order, inserted };
}

function captureSuite(makeStore: () => EventStore): void {
  it('captures real committed events with marks before the snapshot', async () => {
    const store = makeStore();
    const k = kernel();
    const events = await persist(store, k);
    const observed = observeStore(store);
    expect(await captureSnapshotIfDue(observed.port, events, k.projection)).toEqual({
      captured: true,
      trigger: 'event-count',
    });
    expect(observed.order).toEqual(['mark', 'save']);
    expect(observed.inserted).toEqual([[4]]);
    const saved = await store.loadSnapshot(projectId(k));
    expect(saved?.seq).toBe(k.currentSeq);
    expect(saved?.state['capture_anchor']).toEqual({
      seq: k.currentSeq,
      at: events.at(-1)?.occurred_at,
    });
    if (saved === null) throw new Error('capture missing');
    expect(canonicalJson(ProjectStateKernel.fromEvents(k.events, saved).projection)).toBe(
      canonicalJson(k.projection),
    );
  });
  it('advances a later capture at the same business version and retries as a no-op', async () => {
    const store = makeStore();
    const k = kernel();
    const first = await persist(store, k);
    await captureSnapshotIfDue(store, first, k.projection);
    const previous = k.currentSeq;
    for (let i = 0; i < 4; i++) {
      must(
        k.createWork({
          actor: HUMAN,
          at: atDay(1),
          title: 'work ' + String(i),
          reason: 'continue',
          expected_version: 0,
        }),
      );
    }
    const second = await persist(store, k, previous);
    expect(k.stateVersion).toBe(0);
    expect((await captureSnapshotIfDue(store, second, k.projection)).captured).toBe(true);
    expect((await store.loadSnapshot(projectId(k)))?.seq).toBe(k.currentSeq);
    expect((await captureSnapshotIfDue(store, second, k.projection)).captured).toBe(false);
  });
  it('recovers after an actual snapshot-save failure with nonempty marks already written', async () => {
    const store = makeStore();
    const k = kernel();
    const events = await persist(store, k);
    const observed = observeStore(store, true);
    await expect(captureSnapshotIfDue(observed.port, events, k.projection)).rejects.toThrow(
      /injected snapshot failure/,
    );
    expect(observed.inserted).toEqual([[4]]);
    expect(await store.loadSnapshot(projectId(k))).toBeNull();
    expect((await captureSnapshotIfDue(observed.port, events, k.projection)).captured).toBe(true);
    expect(observed.inserted).toEqual([[4], []]);
    expect(observed.order).toEqual(['mark', 'save', 'mark', 'save']);
    expect(await store.loadEvents(projectId(k), 0)).toEqual(events);
  });
  it('does not capture before either window and uses only event time when the time window fires', async () => {
    const store = makeStore();
    const k = kernel(500);
    const initial = await persist(store, k);
    expect((await captureSnapshotIfDue(store, initial, k.projection)).captured).toBe(false);
    const previous = k.currentSeq;
    must(
      k.createWork({
        actor: HUMAN,
        at: atDay(7),
        title: 'later work',
        reason: 'continue',
        expected_version: 0,
      }),
    );
    const later = await persist(store, k, previous);
    expect(await captureSnapshotIfDue(store, later, k.projection)).toEqual({
      captured: true,
      trigger: 'time-window',
    });
    expect((await store.loadSnapshot(projectId(k)))?.state['capture_anchor']).toEqual({
      seq: k.currentSeq,
      at: atDay(7),
    });
  });
  it('detaches its observation before a command completes during the first await', async () => {
    const store = makeStore();
    const k = kernel();
    const events = await persist(store, k);
    const oldLog = k.events;
    const observation = structuredClone(k.projection);
    const pending = captureSnapshotIfDue(store, events, observation);
    const work = must(
      k.createWork({
        actor: HUMAN,
        at: atDay(1),
        title: 'concurrent work',
        reason: 'continue',
        expected_version: 0,
      }),
    );
    Object.assign(observation, k.projection);
    await pending;
    const saved = await store.loadSnapshot(projectId(k));
    if (saved === null) throw new Error('capture missing');
    const restored = ProjectStateKernel.fromEvents(oldLog, saved);
    expect(restored.projection.works[work.id]).toBeUndefined();
    expect(restored.verifyIntegrity().ok).toBe(true);
  });
  it('rejects mixed observations and foreign projects before writing marks', async () => {
    const store = makeStore();
    const k = kernel();
    const events = await persist(store, k);
    const observed = observeStore(store);
    must(
      k.createWork({
        actor: HUMAN,
        at: atDay(1),
        title: 'new work',
        reason: 'continue',
        expected_version: 0,
      }),
    );
    await expect(captureSnapshotIfDue(observed.port, events, k.projection)).rejects.toThrow(
      /same observation/,
    );
    await expect(captureSnapshotIfDue(observed.port, events, kernel().projection)).rejects.toThrow(
      /same observation/,
    );
    expect(observed.order).toEqual([]);
  });

  it('rejects a log whose creation fact contradicts the projection identity', async () => {
    const store = makeStore();
    const k = kernel();
    const events = await persist(store, k);
    const observed = observeStore(store);
    const forged = events.map((event) =>
      event.event_type === 'project.created'
        ? { ...event, payload: { ...event.payload, project_id: uuidv7() } }
        : event,
    );
    await expect(captureSnapshotIfDue(observed.port, forged, k.projection)).rejects.toThrow(
      /project or state version/,
    );
    expect(observed.order).toEqual([]);
  });
  it('rejects corrupt projection state before persistence', async () => {
    const store = makeStore();
    const k = kernel();
    const events = await persist(store, k);
    const corrupted = { ...k.projection, assets: null } as unknown as KernelProjection;
    const observed = observeStore(store);
    await expect(captureSnapshotIfDue(observed.port, events, corrupted)).rejects.toThrow();
    expect(observed.order).toEqual([]);
  });
  it('keeps a newer stored capture when an old observation is retried', async () => {
    const store = makeStore();
    const k = kernel();
    const initial = await persist(store, k);
    const initialProjection = k.projection;
    await captureSnapshotIfDue(store, initial, initialProjection);
    const previous = k.currentSeq;
    for (let i = 0; i < 4; i++)
      must(
        k.createWork({
          actor: HUMAN,
          at: atDay(1),
          title: String(i),
          reason: 'continue',
          expected_version: 0,
        }),
      );
    const later = await persist(store, k, previous);
    await captureSnapshotIfDue(store, later, k.projection);
    expect((await captureSnapshotIfDue(store, initial, initialProjection)).captured).toBe(false);
    expect((await store.loadSnapshot(projectId(k)))?.seq).toBe(k.currentSeq);
  });
  it('rejects different state claiming an already captured cursor', async () => {
    const store = makeStore();
    const k = kernel();
    const events = await persist(store, k);
    await captureSnapshotIfDue(store, events, k.projection);
    const project = k.projection.project;
    if (project === null) throw new Error('project missing');
    const different = { ...k.projection, project: { ...project, title: 'different observation' } };
    await expect(captureSnapshotIfDue(store, events, different)).rejects.toThrow(
      /snapshot-content-conflict/,
    );
  });
  it('returns no-op for an empty log and refuses a missing policy on a nonempty log', async () => {
    const store = makeStore();
    const empty = new ProjectStateKernel();
    expect(await captureSnapshotIfDue(store, [], empty.projection)).toEqual({
      captured: false,
      trigger: null,
    });
    const k = kernel();
    const events = await persist(store, k);
    await expect(
      captureSnapshotIfDue(store, events, { ...k.projection, policy: null }),
    ).rejects.toThrow(/no policy row/);
  });
  it('fails loudly on a corrupt or anchorless stored snapshot before writing marks', async () => {
    const store = makeStore();
    const k = kernel();
    const events = await persist(store, k);
    const head = events.at(-1);
    if (head === undefined) throw new Error('fixture log empty');
    // Corrupt stored snapshot at an earlier cursor: the projection state
    // fails its own contract, so the flow refuses before writing marks.
    await store.saveSnapshot(projectId(k), {
      state_version: 0,
      seq: 1,
      schema_version: 1,
      state: { seq: 1, assets: 'corrupt' },
    });
    const observed = observeStore(store);
    await expect(captureSnapshotIfDue(observed.port, events, k.projection)).rejects.toThrow(
      /capture flow:/,
    );
    expect(observed.order).toEqual([]);
    // Anchorless stored snapshot at a different earlier cursor: usable
    // projection state, but no capture anchor to continue from.
    await store.saveSnapshot(projectId(k), {
      state_version: 0,
      seq: 2,
      schema_version: 1,
      state: { seq: 2 },
    });
    const second = observeStore(store);
    await expect(captureSnapshotIfDue(second.port, events, k.projection)).rejects.toThrow(
      /capture flow:/,
    );
    expect(second.order).toEqual([]);
    // An anchorless stored snapshot: a valid projection payload stripped of
    // its capture anchor — usable state, but no continuation point.
    const full = serializeProjectionStateRecord(k.projection);
    const anchorlessState = {
      ...Object.fromEntries(Object.entries(full).filter(([key]) => key !== 'capture_anchor')),
      seq: 3,
    };
    await store.saveSnapshot(projectId(k), {
      state_version: 0,
      seq: 3,
      schema_version: 1,
      state: anchorlessState,
    });
    const third = observeStore(store);
    await expect(captureSnapshotIfDue(third.port, events, k.projection)).rejects.toThrow(
      /no capture anchor/,
    );
    expect(third.order).toEqual([]);
  });
}

describe('capture with InMemoryEventStore', () => {
  captureSuite(() => new InMemoryEventStore());
});
const databaseUrl = process.env['DATABASE_URL'];
describe.runIf(databaseUrl !== undefined)('capture with PostgreSQL', () => {
  const sql = databaseUrl === undefined ? undefined : createConnection(databaseUrl);
  beforeAll(async () => {
    if (sql) await runMigrations(sql);
  });
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 0 });
  });
  captureSuite(() => {
    if (!sql) throw new Error('DATABASE_URL is required for capture integration');
    return new PostgresEventStore(sql);
  });
});
