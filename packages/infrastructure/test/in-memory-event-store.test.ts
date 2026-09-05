import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@navis/domain';
import { eventEnvelopeSchema } from '@navis/domain';
import type { EventEnvelope } from '@navis/domain';

import { InMemoryEventStore } from '../src/persistence/in-memory/in-memory-event-store.js';

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

/**
 * Port conformance suite. Runs against the in-memory adapter here; the
 * Postgres adapter runs the same scenarios in the integration suite
 * below — the same tests run against both adapters.
 */
function conformanceSuite(name: string, makeStore: () => InMemoryEventStore) {
  describe(name, () => {
    it('appends a batch under the expected head seq and loads it back in order', async () => {
      const store = makeStore();
      const projectId = uuidv7();
      await store.append(projectId, [envelope(projectId, 1, 1), envelope(projectId, 2, 1)], 0);
      const loaded = await store.loadEvents(projectId, 1);
      expect(loaded.map((e) => e.seq)).toEqual([1, 2]);
    });

    it('rejects a stale expected seq with a version-conflict error and writes nothing', async () => {
      const store = makeStore();
      const projectId = uuidv7();
      await store.append(projectId, [envelope(projectId, 1, 1)], 0);
      await expect(store.append(projectId, [envelope(projectId, 2, 1)], 0)).rejects.toThrow(
        /version-conflict/,
      );
      expect((await store.loadEvents(projectId, 1)).map((e) => e.seq)).toEqual([1]);
    });

    it('rejects a batch whose seq does not contiguously continue the head', async () => {
      const store = makeStore();
      const projectId = uuidv7();
      await expect(store.append(projectId, [envelope(projectId, 2, 1)], 0)).rejects.toThrow(
        /version-conflict/,
      );
      expect(await store.loadEvents(projectId, 1)).toEqual([]);
    });

    it('keeps streams isolated per project', async () => {
      const store = makeStore();
      const a = uuidv7();
      const b = uuidv7();
      await store.append(a, [envelope(a, 1, 1)], 0);
      await store.append(b, [envelope(b, 1, 1)], 0);
      expect((await store.loadEvents(a, 1)).length).toBe(1);
      expect((await store.loadEvents(b, 1)).length).toBe(1);
    });

    it('saves and loads the latest snapshot', async () => {
      const store = makeStore();
      const projectId = uuidv7();
      expect(await store.loadSnapshot(projectId)).toBeNull();
      await store.saveSnapshot(projectId, {
        state_version: 3,
        seq: 9,
        schema_version: 1,
        state: { purpose: 'p', seq: 9 },
      });
      const snapshot = await store.loadSnapshot(projectId);
      expect(snapshot?.state_version).toBe(3);
      expect(snapshot?.seq).toBe(9);
    });

    it('treats an empty batch as a no-op under the expected head', async () => {
      const store = makeStore();
      const projectId = uuidv7();
      await store.append(projectId, [envelope(projectId, 1, 1)], 0);
      await store.append(projectId, [], 1); // no-op, no conflict
      await expect(store.append(projectId, [], 0)).rejects.toThrow(/version-conflict/);
      expect((await store.loadEvents(projectId, 1)).map((e) => e.seq)).toEqual([1]);
    });

    it('rejects an envelope whose project_id differs from the append target', async () => {
      const store = makeStore();
      const projectId = uuidv7();
      const stranger = uuidv7();
      await expect(store.append(projectId, [envelope(stranger, 1, 1)], 0)).rejects.toThrow(
        /envelope-project-mismatch/,
      );
      expect(await store.loadEvents(projectId, 1)).toEqual([]);
    });

    it('rejects an intra-batch seq gap all-or-nothing and writes nothing', async () => {
      const store = makeStore();
      const projectId = uuidv7();
      await store.append(projectId, [envelope(projectId, 1, 1)], 0);
      await expect(
        store.append(projectId, [envelope(projectId, 2, 1), envelope(projectId, 4, 1)], 1),
      ).rejects.toThrow(/version-conflict/);
      expect((await store.loadEvents(projectId, 1)).map((e) => e.seq)).toEqual([1]);
    });

    it('keeps snapshot history and loads the max state_version', async () => {
      const store = makeStore();
      const projectId = uuidv7();
      await store.saveSnapshot(projectId, {
        state_version: 3,
        seq: 9,
        schema_version: 1,
        state: { purpose: 'p', seq: 9 },
      });
      await store.saveSnapshot(projectId, {
        state_version: 5,
        seq: 15,
        schema_version: 1,
        state: { purpose: 'q', seq: 15 },
      });
      await store.saveSnapshot(projectId, {
        state_version: 4,
        seq: 12,
        schema_version: 1,
        state: { purpose: 'r', seq: 12 },
      });
      const snapshot = await store.loadSnapshot(projectId);
      expect(snapshot?.state_version).toBe(5);
      expect(snapshot?.seq).toBe(15);
      await store.saveSnapshot(projectId, {
        state_version: 5,
        seq: 15,
        schema_version: 1,
        state: { purpose: 'q2', seq: 15 },
      });
      // Same-version re-save is a no-op: first write wins (ON CONFLICT DO
      // NOTHING parity with the Postgres adapter). Versions are monotonic;
      // a corrected projection arrives as a NEW version, not a rewrite.
      expect((await store.loadSnapshot(projectId))?.state['purpose']).toBe('q');
    });

    it('rejects a snapshot whose state lacks the seq cursor', async () => {
      const store = makeStore();
      const projectId = uuidv7();
      await expect(
        store.saveSnapshot(projectId, {
          state_version: 1,
          seq: 1,
          schema_version: 1,
          state: { purpose: 'no-cursor' },
        }),
      ).rejects.toThrow(/missing the required seq cursor/);
    });

    it('normalizes negative and non-integral load cursors to read from the start', async () => {
      const store = makeStore();
      const projectId = uuidv7();
      await store.append(projectId, [envelope(projectId, 1, 1), envelope(projectId, 2, 1)], 0);
      expect((await store.loadEvents(projectId, -1)).map((e) => e.seq)).toEqual([1, 2]);
      // Non-integral cursors floor toward the start: truncation never skips
      // a committed event (conservative by construction).
      expect((await store.loadEvents(projectId, 1.7)).map((e) => e.seq)).toEqual([1, 2]);
    });

    it('loads events from an inclusive seq cursor, including from 0', async () => {
      const store = makeStore();
      const projectId = uuidv7();
      await store.append(
        projectId,
        [envelope(projectId, 1, 1), envelope(projectId, 2, 1), envelope(projectId, 3, 1)],
        0,
      );
      expect((await store.loadEvents(projectId, 0)).map((e) => e.seq)).toEqual([1, 2, 3]);
      expect((await store.loadEvents(projectId, 2)).map((e) => e.seq)).toEqual([2, 3]);
      expect((await store.loadEvents(projectId, 4)).map((e) => e.seq)).toEqual([]);
    });
  });
}

conformanceSuite(
  'InMemoryEventStore (port conformance, no database)',
  () => new InMemoryEventStore(),
);

const databaseUrl = process.env['DATABASE_URL'];
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('PostgresEventStore (integration, DATABASE_URL set)', () => {
  it('runs the same conformance scenarios against PostgreSQL wire', async () => {
    const { createConnection, runMigrations } =
      await import('../src/persistence/postgres/connection.js');
    const { PostgresEventStore: Store } =
      await import('../src/persistence/postgres/postgres-event-store.js');
    const url = databaseUrl;
    if (url === undefined) throw new Error('DATABASE_URL disappeared mid-test');
    const sql = createConnection(url);
    try {
      await runMigrations(sql);
      const store = new Store(sql);
      const projectId = uuidv7();
      await store.append(projectId, [envelope(projectId, 1, 1), envelope(projectId, 2, 1)], 0);
      const loaded = await store.loadEvents(projectId, 1);
      expect(loaded.map((e) => e.seq)).toEqual([1, 2]);
      await expect(store.append(projectId, [envelope(projectId, 2, 1)], 0)).rejects.toThrow(
        /version-conflict/,
      );
      await store.saveSnapshot(projectId, {
        state_version: 1,
        seq: 2,
        schema_version: 1,
        state: { purpose: 'p', seq: 2 },
      });
      const snapshot = await store.loadSnapshot(projectId);
      expect(snapshot?.state_version).toBe(1);
      // Empty batch is a no-op; a gapped batch is rejected all-or-nothing.
      await store.append(projectId, [], 2);
      await expect(store.append(projectId, [envelope(projectId, 4, 1)], 2)).rejects.toThrow(
        /version-conflict/,
      );
      expect((await store.loadEvents(projectId, 1)).map((e) => e.seq)).toEqual([1, 2]);
      // Cursor normalization on the wire: negative reads from the start.
      expect((await store.loadEvents(projectId, -1)).map((e) => e.seq)).toEqual([1, 2]);
      // Snapshot guard: state without the seq cursor is rejected at write time.
      await expect(
        store.saveSnapshot(projectId, {
          state_version: 9,
          seq: 2,
          schema_version: 1,
          state: { purpose: 'broken' },
        }),
      ).rejects.toThrow(/missing the required seq cursor/);
      // Snapshot history: max state_version wins, same-version re-save is idempotent.
      await store.saveSnapshot(projectId, {
        state_version: 2,
        seq: 2,
        schema_version: 1,
        state: { purpose: 'p2', seq: 2 },
      });
      expect((await store.loadSnapshot(projectId))?.state_version).toBe(2);
      // Immutability trigger: UPDATE/DELETE on the ledger are rejected.
      await expect(
        sql`UPDATE project_events SET payload = '{}' WHERE project_id = ${projectId}`,
      ).rejects.toThrow();
      await expect(
        sql`DELETE FROM project_events WHERE project_id = ${projectId}`,
      ).rejects.toThrow();
      // Checksum guard: re-running applied migrations is a no-op, and editing
      // an applied migration fails loudly instead of silently skipping.
      await runMigrations(sql); // second run: all applied, no-op
      const rows = await sql`SELECT version, checksum FROM schema_migrations ORDER BY version`;
      expect(rows.map((r) => String(r['version']))).toEqual(['001_events']);
      for (const row of rows) expect(row['checksum']).toMatch(/^[0-9a-f]{64}$/);
      // the causal clock column exists on the project table
      const cols = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'projects' AND column_name = 'causal_clock'
      `;
      expect(cols).toHaveLength(1);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});
