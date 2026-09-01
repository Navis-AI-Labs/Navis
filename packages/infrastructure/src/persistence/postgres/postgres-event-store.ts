import type postgres from 'postgres';
import {
  eventEnvelopeSchema,
  type EventEnvelope,
  type EventStore,
  type ProjectionSnapshot,
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
    // The head test-and-set plus INSERT ride ONE transaction: two racing
    // appends with the same expected seq cannot both commit. The SELECT
    // alone is not the guard — a concurrent committer between SELECT and
    // INSERT surfaces as a UNIQUE(project_id, seq) violation, which is
    // rethrown below with the same version-conflict semantics.
    try {
      await this.appendInTransaction(projectId, events, expectedSeq);
    } catch (error) {
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
      type Cell = string | number | null;
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
        JSON.stringify(e.payload),
        JSON.stringify(e.metadata),
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
    // Same write-time gate as the in-memory adapter: a snapshot whose state
    // lacks the seq cursor would poison every later load.
    const seq = snapshot.state['seq'];
    if (typeof seq !== 'number' || !Number.isFinite(seq)) {
      throw new Error('snapshot state is missing the required seq cursor');
    }
    await this.sql`
      INSERT INTO project_snapshots (project_id, state_version, schema_version, state, created_at)
      VALUES (${projectId}, ${snapshot.state_version}, ${snapshot.schema_version},
              ${JSON.stringify(snapshot.state)}, now())
      ON CONFLICT (project_id, state_version) DO NOTHING
    `;
  }

  async loadSnapshot(projectId: string): Promise<ProjectionSnapshot | null> {
    const rows = await this.sql`
      SELECT state_version, schema_version, state
      FROM project_snapshots
      WHERE project_id = ${projectId}
      ORDER BY state_version DESC LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const state = parseJsonb(row['state'], 'project_snapshots.state');
    const seq = state['seq'];
    if (typeof seq !== 'number') {
      throw new Error('snapshot state is missing the required seq cursor');
    }
    return {
      state_version: Number(row['state_version']),
      schema_version: Number(row['schema_version']),
      state,
      seq,
    };
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
