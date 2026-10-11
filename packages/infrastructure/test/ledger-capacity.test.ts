import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, eventEnvelopeSchema, EventStoreCapacityError } from '@navis/domain';
import { createConnection, runMigrations } from '../src/persistence/postgres/connection.js';
import { PostgresEventStore } from '../src/persistence/postgres/postgres-event-store.js';
const configured = process.env['DATABASE_URL']?.trim();
const databaseUrl = configured === '' ? undefined : configured;
describe.runIf(databaseUrl !== undefined)('ledger capacity preserves readable authority', () => {
  const sql = databaseUrl === undefined ? undefined : createConnection(databaseUrl);
  beforeAll(async () => {
    if (sql) await runMigrations(sql);
  });
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 0 });
  });
  it('rejects an oversized append atomically and refuses oversized historical reads explicitly', async () => {
    if (!sql) throw new Error('explicit database required');
    const projectId = uuidv7();
    const store = new PostgresEventStore(sql, false, 2048);
    const at = '2026-10-10T00:00:00.000Z';
    const event = (seq: number, text: string) =>
      eventEnvelopeSchema.parse({
        event_id: uuidv7(),
        project_id: projectId,
        seq,
        aggregate_type: 'project',
        aggregate_id: projectId,
        aggregate_revision: seq,
        event_type: 'test.observed',
        event_schema_version: 1,
        occurred_at: at,
        recorded_at: at,
        payload: { text },
        metadata: {},
        privacy_class: 'work',
        state_version: 0,
      });
    await store.append(projectId, [event(1, 'small')], 0);
    expect(await store.loadEvents(projectId, 0)).toHaveLength(1);
    await expect(store.append(projectId, [event(2, 'x'.repeat(2048))], 1)).rejects.toBeInstanceOf(
      EventStoreCapacityError,
    );
    expect(await store.headSeq(projectId)).toBe(1);
    expect(await store.loadEvents(projectId, 0)).toHaveLength(1);
    await expect(
      new PostgresEventStore(sql, false, 1).loadEvents(projectId, 0),
    ).rejects.toBeInstanceOf(EventStoreCapacityError);
  });
});
