import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { eventEnvelopeSchema, uuidv7 } from '@navis/domain';
import type { EventEnvelope } from '@navis/domain';

import { readFileSync } from 'node:fs';

import {
  createConnection,
  POOL_MAX,
  runMigrations,
} from '../src/persistence/postgres/connection.js';
import { InMemoryEventStore } from '../src/persistence/in-memory/in-memory-event-store.js';
import { PostgresEventStore } from '../src/persistence/postgres/postgres-event-store.js';

/**
 * Fake-wire unit suite: exercises the Postgres adapter and the migration
 * runner against a scripted postgres.js stand-in, without any database.
 * The integration suite (DATABASE_URL set) proves the same behavior on a
 * real wire; this suite pins every decision branch deterministically and
 * guards the INSERT shape (one parameter per column per row) forever.
 */

interface RecordedQuery {
  text: string;
  params?: unknown[];
}

interface FakeSqlOptions {
  headRows?: unknown[];
  loadRows?: unknown[];
  snapshotRows?: unknown[];
  appliedRows?: unknown[];
  unsafeError?: Error;
}

function makeFakeSql(options: FakeSqlOptions = {}) {
  const queries: RecordedQuery[] = [];
  const unsafeCalls: RecordedQuery[] = [];
  let beginCount = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join(' ? ');
    queries.push({ text, params: values });
    if (text.includes('SELECT version, checksum FROM schema_migrations')) {
      return Promise.resolve(options.appliedRows ?? []);
    }
    if (text.includes('SELECT seq FROM project_events')) {
      return Promise.resolve(options.headRows ?? []);
    }
    if (text.includes('FROM project_events') && text.includes('ORDER BY seq ASC')) {
      return Promise.resolve(options.loadRows ?? []);
    }
    if (text.includes('FROM project_snapshots')) {
      return Promise.resolve(options.snapshotRows ?? []);
    }
    return Promise.resolve([]);
  };
  const makeTx = () => {
    const tx = Object.assign(tag, {
      unsafe: (text: string, params: unknown[]): Promise<unknown[]> => {
        unsafeCalls.push({ text, params });
        if (options.unsafeError !== undefined) return Promise.reject(options.unsafeError);
        return Promise.resolve([]);
      },
    }) as unknown as postgres.Sql;
    return tx;
  };
  const sql = Object.assign(tag, {
    begin: (cb: (tx: postgres.Sql) => unknown): Promise<unknown> => {
      beginCount += 1;
      return Promise.resolve(cb(makeTx()));
    },
    options: { max: POOL_MAX },
    end: (): Promise<void> => Promise.resolve(),
  }) as unknown as postgres.Sql;
  return { sql, queries, unsafeCalls, beginCount: () => beginCount };
}

function envelope(projectId: string, seq: number, stateVersion: number): EventEnvelope {
  return eventEnvelopeSchema.parse({
    event_id: uuidv7(),
    project_id: projectId,
    seq,
    aggregate_type: 'project',
    aggregate_id: uuidv7(),
    aggregate_revision: seq,
    event_type: 'project.created',
    event_schema_version: 1,
    occurred_at: '2026-08-31T00:00:00.000Z',
    recorded_at: '2026-08-31T00:00:00.000Z',
    payload: {},
    metadata: {},
    privacy_class: 'evidence',
    state_version: stateVersion,
  });
}

// A driver-shaped row: int8 numbers as strings, jsonb as JSON strings,
// timestamptz as Date — exactly what postgres.js 3.4.x returns on the wire.
function driverRow(projectId: string, seq: number): Record<string, unknown> {
  return {
    event_id: uuidv7(),
    project_id: projectId,
    seq: String(seq),
    aggregate_type: 'project',
    aggregate_id: uuidv7(),
    aggregate_revision: String(seq),
    event_type: 'project.created',
    event_schema_version: '1',
    occurred_at: new Date('2026-08-31T00:00:00.000Z'),
    recorded_at: new Date('2026-08-31T00:00:00.000Z'),
    actor_participant_id: null,
    causation_id: null,
    correlation_id: null,
    idempotency_key: null,
    payload: JSON.stringify({ purpose: 'p' }),
    metadata: JSON.stringify({ source: 'test' }),
    privacy_class: 'evidence',
    state_version: String(seq),
  };
}

describe('PostgresEventStore against a scripted wire (unit, no database)', () => {
  it('appends with one parameter per column per row (18 columns × N events)', async () => {
    const fake = makeFakeSql({ headRows: [] });
    const store = new PostgresEventStore(fake.sql);
    const projectId = uuidv7();
    await store.append(projectId, [envelope(projectId, 1, 1), envelope(projectId, 2, 1)], 0);
    expect(fake.beginCount()).toBe(1);
    expect(fake.unsafeCalls).toHaveLength(1);
    const insert = fake.unsafeCalls[0];
    if (insert === undefined) throw new Error('the INSERT never ran');
    expect(insert.text).toContain('INSERT INTO project_events');
    expect(insert.text).toContain('recorded_at');
    // F4 regression guard: the INSERT binds exactly 18 values per row.
    const params = insert.params ?? [];
    expect(params).toHaveLength(36);
    expect(insert.text).toContain('$36');
    // jsonb values are bound as serialized JSON strings.
    expect(params[14]).toBe('{}');
    expect(params[15]).toBe('{}');
  });

  it('rejects a stale expected seq before any INSERT runs', async () => {
    const fake = makeFakeSql({ headRows: [{ seq: '5' }] });
    const store = new PostgresEventStore(fake.sql);
    const projectId = uuidv7();
    await expect(store.append(projectId, [envelope(projectId, 1, 1)], 0)).rejects.toThrow(
      /version-conflict/,
    );
    expect(fake.unsafeCalls).toHaveLength(0);
  });

  it('rejects an intra-batch seq gap and writes nothing', async () => {
    const fake = makeFakeSql({ headRows: [] });
    const store = new PostgresEventStore(fake.sql);
    const projectId = uuidv7();
    await expect(
      store.append(projectId, [envelope(projectId, 1, 1), envelope(projectId, 3, 1)], 0),
    ).rejects.toThrow(/version-conflict/);
    expect(fake.unsafeCalls).toHaveLength(0);
  });

  it('rejects an envelope claimed by another project and writes nothing', async () => {
    const fake = makeFakeSql({ headRows: [] });
    const store = new PostgresEventStore(fake.sql);
    const projectId = uuidv7();
    const stranger = uuidv7();
    await expect(store.append(projectId, [envelope(stranger, 1, 1)], 0)).rejects.toThrow(
      /envelope-project-mismatch/,
    );
    expect(fake.unsafeCalls).toHaveLength(0);
  });

  it('treats an empty batch as a no-op after the head check', async () => {
    const fake = makeFakeSql({ headRows: [{ seq: '3' }] });
    const store = new PostgresEventStore(fake.sql);
    const projectId = uuidv7();
    await store.append(projectId, [], 3);
    expect(fake.unsafeCalls).toHaveLength(0);
  });

  it('rethrows a concurrent-commit unique violation as version-conflict', async () => {
    const fake = makeFakeSql({
      headRows: [],
      unsafeError: new Error(
        'duplicate key value violates unique constraint "project_events_project_id_seq_key"',
      ),
    });
    const store = new PostgresEventStore(fake.sql);
    const projectId = uuidv7();
    await expect(store.append(projectId, [envelope(projectId, 1, 1)], 0)).rejects.toThrow(
      /version-conflict/,
    );
  });

  it('passes unrelated append errors through untouched', async () => {
    const fake = makeFakeSql({ headRows: [], unsafeError: new Error('connection refused') });
    const store = new PostgresEventStore(fake.sql);
    const projectId = uuidv7();
    await expect(store.append(projectId, [envelope(projectId, 1, 1)], 0)).rejects.toThrow(
      /connection refused/,
    );
  });

  it('rejects a snapshot whose state lacks the seq cursor at write time', async () => {
    const fake = makeFakeSql();
    const store = new PostgresEventStore(fake.sql);
    const projectId = uuidv7();
    await expect(
      store.saveSnapshot(projectId, {
        state_version: 1,
        seq: 1,
        schema_version: 1,
        state: { purpose: 'broken' },
      }),
    ).rejects.toThrow(/missing the required seq cursor/);
  });

  it('rejects a snapshot row whose state arrived null instead of degrading', async () => {
    const projectId = uuidv7();
    const fake = makeFakeSql({
      snapshotRows: [{ state_version: '1', schema_version: '1', state: null }],
    });
    await expect(new PostgresEventStore(fake.sql).loadSnapshot(projectId)).rejects.toThrow(
      /contract breach/,
    );
  });

  it('normalizes negative and non-integral cursors before the wire query', async () => {
    const projectId = uuidv7();
    const fake = makeFakeSql({ loadRows: [driverRow(projectId, 1)] });
    await new PostgresEventStore(fake.sql).loadEvents(projectId, -5);
    const q = fake.queries.find((query) => query.text.includes('FROM project_events'));
    if (q === undefined) throw new Error('load query never ran');
    expect(q.params?.[1]).toBe(0);
    const fake2 = makeFakeSql({ loadRows: [] });
    await new PostgresEventStore(fake2.sql).loadEvents(projectId, 2.9);
    const q2 = fake2.queries.find((query) => query.text.includes('FROM project_events'));
    if (q2 === undefined) throw new Error('load query never ran');
    expect(q2.params?.[1]).toBe(2);
  });

  it('saves snapshots with serialized jsonb state and idempotent conflict target', async () => {
    const fake = makeFakeSql();
    const store = new PostgresEventStore(fake.sql);
    const projectId = uuidv7();
    await store.saveSnapshot(projectId, {
      state_version: 2,
      seq: 2,
      schema_version: 1,
      state: { purpose: 'p2', seq: 2 },
    });
    const q = fake.queries.find((query) => query.text.includes('INSERT INTO project_snapshots'));
    expect(q).toBeDefined();
    expect(q?.params?.[3]).toBe(JSON.stringify({ purpose: 'p2', seq: 2 }));
    expect(String(q?.text)).toContain('ON CONFLICT (project_id, state_version) DO NOTHING');
  });

  it('round-trips driver-shaped rows: int8 strings, jsonb strings, Date instants', async () => {
    const projectId = uuidv7();
    const fake = makeFakeSql({ loadRows: [driverRow(projectId, 1), driverRow(projectId, 2)] });
    const store = new PostgresEventStore(fake.sql);
    const loaded = await store.loadEvents(projectId, 1);
    expect(loaded.map((e) => e.seq)).toEqual([1, 2]);
    expect(loaded[0]?.payload).toEqual({ purpose: 'p' });
    expect(loaded[0]?.metadata).toEqual({ source: 'test' });
    expect(loaded[0]?.occurred_at).toBe('2026-08-31T00:00:00.000Z');
    expect(loaded[0]?.state_version).toBe(1);
  });

  it('parses snapshot state delivered as a JSON string and rejects a missing seq cursor', async () => {
    const projectId = uuidv7();
    const asString = makeFakeSql({
      snapshotRows: [
        {
          state_version: '2',
          schema_version: '1',
          state: JSON.stringify({ purpose: 'p', seq: 2 }),
        },
      ],
    });
    const fromWire = await new PostgresEventStore(asString.sql).loadSnapshot(projectId);
    expect(fromWire?.state_version).toBe(2);
    expect(fromWire?.state['purpose']).toBe('p');
    expect(fromWire?.seq).toBe(2);

    const missing = makeFakeSql({
      snapshotRows: [{ state_version: '1', schema_version: '1', state: { purpose: 'p' } }],
    });
    await expect(new PostgresEventStore(missing.sql).loadSnapshot(projectId)).rejects.toThrow(
      /missing the required seq cursor/,
    );

    const nullState = makeFakeSql({
      snapshotRows: [{ state_version: '1', schema_version: '1', state: null }],
    });
    await expect(new PostgresEventStore(nullState.sql).loadSnapshot(projectId)).rejects.toThrow(
      /contract breach/,
    );

    const empty = makeFakeSql({ snapshotRows: [] });
    await expect(new PostgresEventStore(empty.sql).loadSnapshot(projectId)).resolves.toBeNull();
  });
});

describe('runMigrations against a scripted wire (unit, no database)', () => {
  it('applies a fresh migration and records version + sha256 checksum', async () => {
    const fake = makeFakeSql();
    await runMigrations(fake.sql);
    expect(fake.beginCount()).toBe(1);
    const insert = fake.queries.find((q) => q.text.includes('INSERT INTO schema_migrations'));
    expect(insert).toBeDefined();
    expect(insert?.params?.[0]).toBe('001_events');
    expect(insert?.params?.[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is a no-op when the applied checksum matches the file', async () => {
    const fresh = makeFakeSql();
    await runMigrations(fresh.sql);
    const insert = fresh.queries.find((q) => q.text.includes('INSERT INTO schema_migrations'));
    const checksum = insert?.params?.[1] as string;
    const again = makeFakeSql({ appliedRows: [{ version: '001_events', checksum }] });
    await runMigrations(again.sql);
    expect(again.beginCount()).toBe(0);
  });

  it('fails loudly when an applied migration file changes (checksum drift)', async () => {
    const drifted = makeFakeSql({
      appliedRows: [{ version: '001_events', checksum: 'a'.repeat(64) }],
    });
    await expect(runMigrations(drifted.sql)).rejects.toThrow(/checksum mismatch/);
  });
});

describe('createConnection (unit)', () => {
  it('builds a pooled wire endpoint from DATABASE_URL alone', async () => {
    const sql = createConnection('postgres://postgres@127.0.0.1:54329/navis_test');
    expect(sql.options.max).toBe(POOL_MAX);
    await sql.end({ timeout: 0 });
  });
});

describe('delete-semantics invariants (structural guards, no database)', () => {
  const sqlText = readFileSync(
    new URL('../src/persistence/postgres/migrations/001_events.sql', import.meta.url),
    'utf8',
  );

  it('EventStore port exposes exactly the four non-destructive operations — no delete ever', () => {
    for (const adapter of [InMemoryEventStore, PostgresEventStore]) {
      const methods = Object.getOwnPropertyNames(adapter.prototype).filter(
        (m) => m !== 'constructor' && m !== 'appendInTransaction',
      );
      expect(methods.sort()).toEqual(['append', 'loadEvents', 'loadSnapshot', 'saveSnapshot']);
    }
  });

  it('the ledger never retires rows: no tombstone column on project_events', () => {
    const block = sqlText.slice(
      sqlText.indexOf('CREATE TABLE IF NOT EXISTS project_events'),
      sqlText.indexOf('CREATE TABLE IF NOT EXISTS acceptances'),
    );
    expect(block).not.toMatch(/deleted_at/);
    expect(block).not.toMatch(/deleted boolean/i);
  });

  it('physical immutability: an UPDATE/DELETE trigger guards the ledger', () => {
    expect(sqlText).toMatch(/BEFORE UPDATE OR DELETE ON project_events/);
    expect(sqlText).toMatch(/CREATE TRIGGER project_events_append_only_guard/);
  });

  it('retirement lives in projections only: tombstone columns on the quartet tables', () => {
    for (const table of [
      'projects',
      'participants',
      'works',
      'assets',
      'holds',
      'work_runs',
      'acceptances',
      'deliveries',
    ]) {
      const start = sqlText.indexOf(`CREATE TABLE IF NOT EXISTS ${table} `);
      const end = sqlText.indexOf(');', start);
      expect(sqlText.slice(start, end), `${table} must carry deleted_at`).toMatch(/deleted_at/);
    }
  });
});

describe('deployment shape guards (no database)', () => {
  it('L2 carries the per-delivery attempt lineage table with its uniqueness constraint', () => {
    const sqlText = readFileSync(
      new URL('../src/persistence/postgres/migrations/001_events.sql', import.meta.url),
      'utf8',
    );
    const start = sqlText.indexOf('CREATE TABLE IF NOT EXISTS delivery_attempts ');
    expect(start).toBeGreaterThan(0);
    const end = sqlText.indexOf(');', start);
    const block = sqlText.slice(start, end);
    expect(block).toMatch(/UNIQUE \(delivery_id, attempt_no\)/);
    expect(block).toMatch(/deleted_at/);
    expect(block).toMatch(/outcome\s+text NOT NULL/);
  });

  it('holds store source-event lineage only in the relation table, not a column array', () => {
    const sqlText = readFileSync(
      new URL('../src/persistence/postgres/migrations/001_events.sql', import.meta.url),
      'utf8',
    );
    const start = sqlText.indexOf('CREATE TABLE IF NOT EXISTS holds ');
    const end = sqlText.indexOf(');', start);
    expect(sqlText.slice(start, end)).not.toMatch(/source_event_ids/);
    expect(sqlText).toMatch(/CREATE TABLE IF NOT EXISTS hold_source_events/);
  });

  it('the built package carries the migrations directory — the runner reads it from its own dist path', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['build']).toMatch(/migrations/);
    const dir = new URL('../src/persistence/postgres/migrations/', import.meta.url);
    expect(readFileSync(new URL('001_events.sql', dir), 'utf8')).toMatch(
      /CREATE TABLE IF NOT EXISTS project_events/,
    );
  });
});
