import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  archivableEventTypes,
  eventEnvelopeSchema,
  retentionClassSchema,
  uuidv7,
  type EventEnvelope,
  type EventStore,
  type ProjectionSnapshot,
} from '@navis/domain';
import { InMemoryEventStore } from '../src/persistence/in-memory/in-memory-event-store.js';
import { PostgresEventStore } from '../src/persistence/postgres/postgres-event-store.js';
import { createConnection, runMigrations } from '../src/persistence/postgres/connection.js';

const AT = '2026-09-08T00:00:00.000Z';

function envelope(
  projectId: string,
  seq: number,
  stateVersion = 0,
  type = 'workrun.transitioned',
): EventEnvelope {
  return eventEnvelopeSchema.parse({
    event_id: uuidv7(),
    project_id: projectId,
    seq,
    aggregate_type: 'project',
    aggregate_id: projectId,
    aggregate_revision: seq,
    event_type: type,
    event_schema_version: 1,
    occurred_at: AT,
    recorded_at: AT,
    payload: { label: 'original' },
    metadata: {},
    privacy_class: 'audit',
    state_version: stateVersion,
  });
}

function snapshot(seq: number, stateVersion = 0, label = 'original'): ProjectionSnapshot {
  return { seq, state_version: stateVersion, schema_version: 1, state: { seq, label } };
}

function conformanceSuite(makeStore: () => EventStore): void {
  it('loads an empty stream and no snapshot for a new project', async () => {
    const store = makeStore();
    const id = uuidv7();
    expect(await store.loadEvents(id, 0)).toEqual([]);
    expect(await store.loadSnapshot(id)).toBeNull();
  });
  it('appends a contiguous batch and loads cursor-inclusive history', async () => {
    const store = makeStore();
    const id = uuidv7();
    await store.append(id, [envelope(id, 1), envelope(id, 2)], 0);
    expect((await store.loadEvents(id, 0)).map((e) => e.seq)).toEqual([1, 2]);
    expect((await store.loadEvents(id, 2)).map((e) => e.seq)).toEqual([2]);
    expect((await store.loadEvents(id, -1)).map((e) => e.seq)).toEqual([1, 2]);
    expect((await store.loadEvents(id, 1.9)).map((e) => e.seq)).toEqual([1, 2]);
  });
  it('owns input before its first await and isolates returned values', async () => {
    const store = makeStore();
    const id = uuidv7();
    const input = envelope(id, 1);
    const pending = store.append(id, [input], 0);
    input.payload['label'] = 'changed while pending';
    await pending;
    const read = await store.loadEvents(id, 0);
    expect(read[0]?.payload['label']).toBe('original');
    try {
      if (read[0]) read[0].payload['label'] = 'changed after load';
    } catch {
      /* immutable view */
    }
    expect((await store.loadEvents(id, 0))[0]?.payload['label']).toBe('original');
  });
  it('rejects stale writers and preserves the committed stream', async () => {
    const store = makeStore();
    const id = uuidv7();
    await store.append(id, [envelope(id, 1)], 0);
    await expect(store.append(id, [envelope(id, 2)], 0)).rejects.toThrow(/version-conflict/);
    expect((await store.loadEvents(id, 0)).map((e) => e.seq)).toEqual([1]);
  });
  it('rejects an entire gapped batch and leaves no partial write', async () => {
    const store = makeStore();
    const id = uuidv7();
    await expect(store.append(id, [envelope(id, 1), envelope(id, 3)], 0)).rejects.toThrow(
      /version-conflict/,
    );
    expect(await store.loadEvents(id, 0)).toEqual([]);
  });
  it('isolates projects and rejects an envelope for another project', async () => {
    const store = makeStore();
    const a = uuidv7();
    const b = uuidv7();
    await store.append(a, [envelope(a, 1)], 0);
    await store.append(b, [envelope(b, 1)], 0);
    await expect(store.append(a, [envelope(b, 2)], 1)).rejects.toThrow(/envelope-project-mismatch/);
    expect((await store.loadEvents(a, 0)).map((e) => e.seq)).toEqual([1]);
    expect((await store.loadEvents(b, 0)).map((e) => e.seq)).toEqual([1]);
  });
  it('rejects a batch with a duplicate event identity internally, appending nothing', async () => {
    const store = makeStore();
    const id = uuidv7();
    const e1 = envelope(id, 1);
    const e2 = { ...envelope(id, 2), event_id: e1.event_id };
    await expect(store.append(id, [e1, e2], 0)).rejects.toThrow(/event-id-conflict/);
    expect(await store.loadEvents(id, 0)).toEqual([]);
    expect(await store.markRetention(id, 1, 2, 'permanent')).toEqual([]);
  });
  it('rejects a later batch that reuses an already committed event identity', async () => {
    const store = makeStore();
    const id = uuidv7();
    const committed = envelope(id, 1, 0, 'acceptance.recorded');
    await store.append(id, [committed], 0);
    await expect(
      store.append(id, [{ ...envelope(id, 2), event_id: committed.event_id }], 1),
    ).rejects.toThrow(/event-id-conflict/);
    expect((await store.loadEvents(id, 0)).map((e) => e.event_id)).toEqual([committed.event_id]);
  });
  it('rejects an event identity already committed to another project without touching either stream', async () => {
    const store = makeStore();
    const a = uuidv7();
    const b = uuidv7();
    const committed = envelope(a, 1);
    await store.append(a, [committed], 0);
    await expect(
      store.append(b, [{ ...envelope(b, 1), event_id: committed.event_id }], 0),
    ).rejects.toThrow(/event-id-conflict/);
    expect(await store.loadEvents(a, 0)).toHaveLength(1);
    expect(await store.loadEvents(b, 0)).toEqual([]);
  });
  it('allows exactly one concurrent append at a shared expected cursor', async () => {
    const store = makeStore();
    const id = uuidv7();
    const results = await Promise.allSettled([
      store.append(id, [envelope(id, 1)], 0),
      store.append(id, [envelope(id, 1)], 0),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await store.loadEvents(id, 0)).toHaveLength(1);
  });
  it('checks the expected cursor even for an empty append', async () => {
    const store = makeStore();
    const id = uuidv7();
    await store.append(id, [envelope(id, 1)], 0);
    await store.append(id, [], 1);
    await expect(store.append(id, [], 0)).rejects.toThrow(/version-conflict/);
  });
  it('advances snapshots at an unchanged business version and loads by event cursor', async () => {
    const store = makeStore();
    const id = uuidv7();
    await store.append(id, [envelope(id, 1), envelope(id, 2), envelope(id, 3)], 0);
    await store.saveSnapshot(id, snapshot(1));
    await store.saveSnapshot(id, snapshot(3));
    await store.saveSnapshot(id, snapshot(2));
    expect(await store.loadSnapshot(id)).toEqual(snapshot(3));
  });
  it('rejects uncommitted and wrong-version snapshot cursors', async () => {
    const store = makeStore();
    const id = uuidv7();
    await expect(store.saveSnapshot(id, snapshot(1))).rejects.toThrow(/not committed/);
    await store.append(id, [envelope(id, 1)], 0);
    await expect(store.saveSnapshot(id, snapshot(1, 99))).rejects.toThrow(/not committed/);
    expect(await store.loadSnapshot(id)).toBeNull();
  });
  it('keeps identical snapshot retries and refuses conflicting content', async () => {
    const store = makeStore();
    const id = uuidv7();
    await store.append(id, [envelope(id, 1)], 0);
    await store.saveSnapshot(id, snapshot(1));
    await store.saveSnapshot(id, snapshot(1));
    await expect(store.saveSnapshot(id, snapshot(1, 0, 'different'))).rejects.toThrow(
      /snapshot-content-conflict/,
    );
    expect(await store.loadSnapshot(id)).toEqual(snapshot(1));
  });
  it('refuses contradictory snapshot cursors and non-JSON state', async () => {
    const store = makeStore();
    const id = uuidv7();
    await store.append(id, [envelope(id, 1)], 0);
    await expect(store.saveSnapshot(id, { ...snapshot(1), state: { seq: 2 } })).rejects.toThrow(
      /seq cursor/,
    );
    await expect(
      store.saveSnapshot(id, { ...snapshot(1), state: { seq: 1, number: Number.NaN } }),
    ).rejects.toThrow();
    expect(await store.loadSnapshot(id)).toBeNull();
  });
  it('owns snapshot values while persistence is pending and after loading', async () => {
    const store = makeStore();
    const id = uuidv7();
    await store.append(id, [envelope(id, 1)], 0);
    const input = snapshot(1);
    const pending = store.saveSnapshot(id, input);
    input.state['label'] = 'changed';
    await pending;
    const read = await store.loadSnapshot(id);
    expect(read).toEqual(snapshot(1));
    expect(() => {
      if (read) read.state['label'] = 'changed again';
    }).toThrow();
    expect(await store.loadSnapshot(id)).toEqual(snapshot(1));
  });
  it('arbitrates simultaneous different snapshots at one cursor', async () => {
    const store = makeStore();
    const id = uuidv7();
    await store.append(id, [envelope(id, 1)], 0);
    const results = await Promise.allSettled([
      store.saveSnapshot(id, snapshot(1, 0, 'a')),
      store.saveSnapshot(id, snapshot(1, 0, 'b')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('classifies new permanent events before any archival marking', async () => {
    const store = makeStore();
    const id = uuidv7();
    const types = [
      'project.boundary_updated',
      'acceptance.recorded',
      'future.event',
      ...archivableEventTypes,
    ];
    await store.append(
      id,
      types.map((type, i) => envelope(id, i + 1, 0, type)),
      0,
    );
    expect(await store.markRetention(id, 1, types.length, 'archive_after_snapshot')).toEqual([
      4, 5, 6,
    ]);
    expect(await store.markRetention(id, 1, types.length, 'permanent')).toEqual([]);
    expect(await store.loadEvents(id, 0)).toHaveLength(types.length);
  });
  it('marks existing rows in range without iterating absent sequence numbers', async () => {
    const store = makeStore();
    const id = uuidv7();
    await store.append(id, [envelope(id, 1), envelope(id, 2)], 0);
    expect(
      await store.markRetention(id, 1, Number.MAX_SAFE_INTEGER, 'archive_after_snapshot'),
    ).toEqual([1, 2]);
    expect(await store.markRetention(id, 1, 2, 'archive_after_snapshot')).toEqual([]);
    expect(await store.markRetention(id, 2, 1, 'archive_after_snapshot')).toEqual([]);
    await expect(
      store.markRetention(id, 1, Number.POSITIVE_INFINITY, 'archive_after_snapshot'),
    ).rejects.toThrow(/sequence range/);
  });
  it('keeps the first classification on cross-class retries', async () => {
    const store = makeStore();
    const id = uuidv7();
    await store.append(id, [envelope(id, 1), envelope(id, 2)], 0);
    expect(await store.markRetention(id, 1, 1, 'permanent')).toEqual([1]);
    expect(await store.markRetention(id, 1, 2, 'archive_after_snapshot')).toEqual([2]);
    expect(await store.markRetention(id, 1, 2, 'permanent')).toEqual([]);
  });
}

describe('retention vocabulary matches the migration', () => {
  it('pins classes and archive eligibility to the domain definitions', () => {
    const sql = readFileSync(
      new URL('../src/persistence/postgres/migrations/001_events.sql', import.meta.url),
      'utf8',
    );
    const parseList = (pattern: RegExp): string[] => {
      const group = pattern.exec(sql)?.[1];
      if (group === undefined) throw new Error('migration retention declaration missing');
      return group.split(',').map((value) => value.trim().replaceAll("'", ''));
    };
    expect(parseList(/retention_class IN \(([^)]*)\)/)).toEqual(retentionClassSchema.options);
    expect(parseList(/WHERE event_type NOT IN \(([^)]*)\)/)).toEqual(archivableEventTypes);
  });
});

describe('InMemoryEventStore conformance', () => {
  conformanceSuite(() => new InMemoryEventStore());
});

const databaseUrl = process.env['DATABASE_URL'];
describe.runIf(databaseUrl !== undefined)('PostgresEventStore conformance', () => {
  const sql = databaseUrl === undefined ? undefined : createConnection(databaseUrl);
  beforeAll(async () => {
    if (sql) await runMigrations(sql);
  });
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 0 });
  });
  conformanceSuite(() => {
    if (!sql) throw new Error('DATABASE_URL is required for this suite');
    return new PostgresEventStore(sql);
  });
  it('enforces ledger immutability and permanent classification in the real database', async () => {
    if (!sql) throw new Error('DATABASE_URL is required for this suite');
    const store = new PostgresEventStore(sql);
    const id = uuidv7();
    await store.append(id, [envelope(id, 1, 0, 'acceptance.recorded')], 0);
    const rows =
      await sql`SELECT retention_class FROM event_retention_marks WHERE project_id = ${id}`;
    const classes: string[] = rows.map((row) => String(row['retention_class']));
    expect(classes).toEqual(['permanent']);
    await expect(
      sql`UPDATE project_events SET payload = '{}' WHERE project_id = ${id}`,
    ).rejects.toThrow();
    await expect(sql`DELETE FROM project_events WHERE project_id = ${id}`).rejects.toThrow();
    await runMigrations(sql);
    const migrations = await sql`SELECT version, checksum FROM schema_migrations`;
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.['checksum']).toMatch(/^[0-9a-f]{64}$/);
  });
});
