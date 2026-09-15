import type postgres from 'postgres';
import {
  eventEnvelopeSchema,
  archivableEventTypes,
  immutableCopy,
  projectionSnapshotSchema,
  retentionClassSchema,
  type EventEnvelope,
  type EventStore,
  type ProjectionSnapshot,
  type RetentionClass,
} from '@navis/domain';

/**
 * Postgres-wire adapter: standard wire protocol only, no platform SDK, no
 * RLS-as-authorization. Optimistic concurrency is
 * enforced by the storage layer: the head test-and-set rides the
 * UNIQUE(project_id, seq) constraint inside the append transaction — two
 * racing appends with the same expected version cannot both succeed.
 */
export class PostgresEventStore implements EventStore {
  private readonly sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  async append(
    projectId: string,
    events: readonly EventEnvelope[],
    expectedSeq: number,
  ): Promise<void> {
    const owned = events.map((event) => immutableCopy(eventEnvelopeSchema.parse(event)));
    // The head test-and-set plus INSERT ride ONE transaction: two racing
    // appends with the same expected seq cannot both commit. The SELECT
    // alone is not the guard — a concurrent committer between SELECT and
    // INSERT surfaces as a UNIQUE(project_id, seq) violation, which is
    // rethrown below with the same version-conflict semantics.
    try {
      await this.appendInTransaction(projectId, owned, expectedSeq);
    } catch (error) {
      const constraint = (error as { readonly constraint?: unknown }).constraint;
      if (
        constraint === 'project_events_pkey' ||
        (error instanceof Error && error.message.includes('project_events_pkey'))
      ) {
        throw new Error(`event-id-conflict: an event identity is already committed`, {
          cause: error,
        });
      }
      if (error instanceof Error && error.message.includes('project_events_project_id_seq_key')) {
        throw new Error(
          `version-conflict: a concurrent append claimed a seq in [${String(expectedSeq)}+${String(events.length - 1)}] for project ${projectId}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async appendInTransaction(
    projectId: string,
    events: readonly EventEnvelope[],
    expectedSeq: number,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      // Head test-and-set: the last committed seq must equal the caller's expected version.
      const rows =
        await tx`SELECT seq FROM project_events WHERE project_id = ${projectId} ORDER BY seq DESC LIMIT 1`;
      const probe = (rows[0] as { seq?: unknown } | undefined)?.seq;
      const head = probe === undefined ? 0 : Number(probe);
      if (head !== expectedSeq) {
        throw new Error(
          `version-conflict: expected ${String(expectedSeq)}, actual ${String(head)}`,
        );
      }
      if (events.length === 0) return; // nothing to append; head check already ran
      // Contiguity: event seqs must continue the head without gaps (storage
      // UNIQUE(project_id, seq) catches duplicates, not gaps).
      events.forEach((e, i) => {
        if (e.seq !== head + i + 1) {
          throw new Error(
            `version-conflict: event seq ${String(e.seq)} does not continue head ${String(head)}`,
          );
        }
        if (e.project_id !== projectId) {
          throw new Error(
            `envelope-project-mismatch: event claims project ${e.project_id}, appending to ${projectId}`,
          );
        }
      });
      // Single parameterized multi-row INSERT: one round trip per append,
      // not one per event; every value is bound as a query parameter.
      const columns =
        'event_id, project_id, seq, aggregate_type, aggregate_id, aggregate_revision, event_type, event_schema_version, occurred_at, recorded_at, actor_participant_id, causation_id, correlation_id, idempotency_key, payload, metadata, privacy_class, state_version';
      type Cell = string | number | null | postgres.Parameter;
      const values: Cell[][] = events.map((e): Cell[] => [
        e.event_id,
        e.project_id,
        e.seq,
        e.aggregate_type,
        e.aggregate_id,
        e.aggregate_revision,
        e.event_type,
        e.event_schema_version,
        e.occurred_at,
        e.recorded_at,
        e.actor_participant_id ?? null,
        e.causation_id ?? null,
        e.correlation_id ?? null,
        e.idempotency_key ?? null,
        // jsonb columns bind through sql.json() — an explicit-oid jsonb
        // Parameter the driver serializes from the object itself. A plain
        // string arrives as text and PG coerces it into a JSON string
        // scalar (double-encoded), which breaks state/payload cursors.
        this.sql.json(e.payload),
        this.sql.json(e.metadata),
        e.privacy_class,
        e.state_version,
      ]);
      const placeholders = values
        .map(
          (_, i) =>
            `($${String(i * 18 + 1)}, $${String(i * 18 + 2)}, $${String(i * 18 + 3)}, $${String(i * 18 + 4)}, $${String(i * 18 + 5)}, $${String(i * 18 + 6)}, $${String(i * 18 + 7)}, $${String(i * 18 + 8)}, $${String(i * 18 + 9)}, $${String(i * 18 + 10)}, $${String(i * 18 + 11)}, $${String(i * 18 + 12)}, $${String(i * 18 + 13)}, $${String(i * 18 + 14)}, $${String(i * 18 + 15)}, $${String(i * 18 + 16)}, $${String(i * 18 + 17)}, $${String(i * 18 + 18)})`,
        )
        .join(', ');
      const flat = values.flat();
      await tx.unsafe(`INSERT INTO project_events (${columns}) VALUES ${placeholders}`, flat);
      await tx`
        INSERT INTO event_retention_marks (project_id, seq, retention_class)
        SELECT project_id, seq, 'permanent' FROM project_events
        WHERE project_id = ${projectId} AND seq > ${head}
          AND NOT (event_type = ANY (${archivableEventTypes}::text[]))
        ON CONFLICT (project_id, seq) DO NOTHING
      `;
    });
  }

  async loadEvents(projectId: string, fromSeq: number): Promise<readonly EventEnvelope[]> {
    const cursor = Math.max(0, Math.floor(fromSeq)); // non-integral/negative cursors read from the start
    const rows = await this.sql`
      SELECT event_id, project_id, seq, aggregate_type, aggregate_id, aggregate_revision,
             event_type, event_schema_version, occurred_at, recorded_at, actor_participant_id,
             causation_id, correlation_id, idempotency_key, payload, metadata, privacy_class,
             state_version
      FROM project_events
      WHERE project_id = ${projectId} AND seq >= ${cursor}
      ORDER BY seq ASC
    `;
    return rows.map((row) => eventEnvelopeSchema.parse(fromRow(row as Record<string, unknown>)));
  }

  async saveSnapshot(projectId: string, snapshot: ProjectionSnapshot): Promise<void> {
    const owned = immutableCopy(projectionSnapshotSchema.parse(snapshot));
    await this.sql.begin(async (tx) => {
      const cursor =
        await tx`SELECT state_version FROM project_events WHERE project_id = ${projectId} AND seq = ${owned.seq}`;
      if (cursor[0] === undefined || Number(cursor[0]['state_version']) !== owned.state_version) {
        throw new Error('snapshot cursor is not committed at the supplied state version');
      }
      const saved = await tx`
        INSERT INTO project_snapshots (project_id, seq, state_version, schema_version, state, created_at)
        VALUES (${projectId}, ${owned.seq}, ${owned.state_version}, ${owned.schema_version}, ${this.sql.json(owned.state)}, now())
        ON CONFLICT (project_id, seq) DO UPDATE SET state = project_snapshots.state
        WHERE project_snapshots.state_version = EXCLUDED.state_version
          AND project_snapshots.schema_version = EXCLUDED.schema_version
          AND project_snapshots.state = EXCLUDED.state
        RETURNING seq
      `;
      if (saved.length === 0)
        throw new Error('snapshot-content-conflict: cursor already has different content');
    });
  }

  async loadSnapshot(projectId: string): Promise<ProjectionSnapshot | null> {
    const rows = await this.sql`
      SELECT seq, state_version, schema_version, state
      FROM project_snapshots
      WHERE project_id = ${projectId}
      ORDER BY seq DESC LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const state = parseJsonb(row['state'], 'project_snapshots.state');
    return immutableCopy(
      projectionSnapshotSchema.parse({
        state_version: Number(row['state_version']),
        schema_version: Number(row['schema_version']),
        state,
        seq: Number(row['seq']),
      }),
    );
  }

  async markRetention(
    projectId: string,
    fromSeq: number,
    toSeq: number,
    retentionClass: RetentionClass,
  ): Promise<readonly number[]> {
    retentionClassSchema.parse(retentionClass);
    if (!Number.isSafeInteger(Math.floor(fromSeq)) || !Number.isSafeInteger(Math.floor(toSeq))) {
      throw new Error('invalid retention sequence range');
    }
    const lo = Math.max(1, Math.floor(fromSeq));
    const hi = Math.floor(toSeq);
    if (hi < lo) return [];
    // Select committed rows in the database so large ranges never require
    // host-side iteration. Existing classifications must survive overlapping
    // captures, and absent events must not acquire retention marks.
    return await this.sql.begin(async (tx) => {
      const inserted = await tx`
        INSERT INTO event_retention_marks (project_id, seq, retention_class)
        SELECT pe.project_id, pe.seq, ${retentionClass}
        FROM project_events pe
        WHERE pe.project_id = ${projectId}
          AND pe.seq >= ${lo}
          AND pe.seq <= ${hi}
          AND (${retentionClass} = 'permanent' OR pe.event_type = ANY (${archivableEventTypes}::text[]))
        ON CONFLICT (project_id, seq) DO NOTHING
        RETURNING seq
      `;
      const rows = inserted as unknown as { seq: unknown }[];
      return rows.map((r) => Number(r.seq)).sort((a, b) => a - b);
    });
  }
}

function parseJsonb(value: unknown, column: string): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new Error(
      `jsonb column ${column} arrived null from the driver — storage contract breach`,
    );
  }
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function fromRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: row['event_id'],
    project_id: row['project_id'],
    seq: Number(row['seq']),
    aggregate_type: row['aggregate_type'],
    aggregate_id: row['aggregate_id'],
    aggregate_revision: Number(row['aggregate_revision']),
    event_type: row['event_type'],
    event_schema_version: Number(row['event_schema_version']),
    occurred_at: (row['occurred_at'] as Date).toISOString(),
    recorded_at: (row['recorded_at'] as Date).toISOString(),
    actor_participant_id: row['actor_participant_id'],
    causation_id: row['causation_id'],
    correlation_id: row['correlation_id'],
    idempotency_key: row['idempotency_key'],
    payload: parseJsonb(row['payload'], 'payload'),
    metadata: parseJsonb(row['metadata'], 'metadata'),
    privacy_class: row['privacy_class'],
    state_version: Number(row['state_version']),
  };
}
