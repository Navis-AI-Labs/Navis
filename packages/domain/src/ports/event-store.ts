import { z } from 'zod';

import { uuidv7Schema } from '../schema/ids.js';
import { instantSchema } from '../schema/time.js';

/**
 * Event envelope + EventStore port (domain layer, zero driver types).
 *
 * The ledger is the single authority: appends are
 * guarded by expected seq (optimistic concurrency carried by the storage
 * layer's UNIQUE(project_id, seq)), loads stream from a seq cursor, and
 * snapshots pin a state_version + seq. The port is engine-neutral —
 * implementations live in infrastructure.
 */

export const eventEnvelopeSchema = z.strictObject({
  event_id: uuidv7Schema,
  project_id: uuidv7Schema,
  seq: z.number().int().min(1),
  aggregate_type: z.string().min(1).max(64),
  aggregate_id: uuidv7Schema,
  aggregate_revision: z.number().int().min(1),
  event_type: z.string().min(1).max(128),
  event_schema_version: z.number().int().min(1),
  occurred_at: instantSchema,
  recorded_at: instantSchema,
  actor_participant_id: uuidv7Schema.nullable().optional(),
  causation_id: z.string().min(1).max(512).nullable().optional(),
  correlation_id: z.string().min(1).max(512).nullable().optional(),
  idempotency_key: z.string().min(1).max(512).nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  privacy_class: z.enum(['evidence', 'work', 'audit']),
  state_version: z.number().int().min(0),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export interface EventStore {
  /**
   * Appends events under optimistic concurrency: the whole batch commits
   * only if `expectedSeq` equals the project's current head seq; otherwise
   * a version-conflict error is returned and nothing is written.
   */
  append(projectId: string, events: readonly EventEnvelope[], expectedSeq: number): Promise<void>;
  /** Streams committed events from the given seq cursor (inclusive) in seq order. */
  loadEvents(projectId: string, fromSeq: number): Promise<readonly EventEnvelope[]>;
  /**
   * Persists a projection snapshot pinned to a state_version + seq. The
   * snapshot's `state` MUST carry a numeric `seq` cursor (the replay
   * resume point) — adapters reject the save otherwise. Saving the same
   * state_version again is a no-op; loading returns the highest saved
   * state_version. Both adapters behave identically here.
   */
  saveSnapshot(projectId: string, snapshot: ProjectionSnapshot): Promise<void>;
  /** Loads the latest snapshot for a project; null when none exists. */
  loadSnapshot(projectId: string): Promise<ProjectionSnapshot | null>;
}

export interface ProjectionSnapshot {
  readonly state_version: number;
  readonly seq: number;
  readonly schema_version: number;
  readonly state: Record<string, unknown>;
}
