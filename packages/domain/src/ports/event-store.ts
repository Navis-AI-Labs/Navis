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
  payload: z.record(z.string(), z.json()),
  metadata: z.record(z.string(), z.json()),
  privacy_class: z.enum(['evidence', 'work', 'audit']),
  state_version: z.number().int().min(0),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Only these event families are eligible for cold archival after a snapshot. */
export const archivableEventTypes: readonly string[] = Object.freeze([
  'asset.created',
  'workrun.started',
  'workrun.transitioned',
]);

export const retentionClassSchema = z.enum(['permanent', 'archive_after_snapshot']);
export type RetentionClass = z.infer<typeof retentionClassSchema>;

/** Unknown event types remain permanent until their retention policy is defined. */
export function eventRetentionClass(eventType: string): RetentionClass {
  return archivableEventTypes.includes(eventType) ? 'archive_after_snapshot' : 'permanent';
}

export const projectionSnapshotSchema = z
  .strictObject({
    state_version: z.number().int().nonnegative(),
    seq: z.number().int().positive(),
    schema_version: z.number().int().positive(),
    state: z.record(z.string(), z.json()),
  })
  .refine((snapshot) => snapshot.state['seq'] === snapshot.seq, {
    path: ['state', 'seq'],
    error: 'snapshot state is missing the required seq cursor or it disagrees with the envelope',
  });

export type ProjectionSnapshot = Readonly<z.infer<typeof projectionSnapshotSchema>>;

export interface EventStore {
  /**
   * Appends events under optimistic concurrency: the whole batch commits
   * only if `expectedSeq` equals the project's current head seq. Permanent
   * retention classifications commit with the events in the same transaction.
   */
  append(projectId: string, events: readonly EventEnvelope[], expectedSeq: number): Promise<void>;
  /** Loads committed events from the given seq cursor (inclusive) in seq order. */
  loadEvents(projectId: string, fromSeq: number): Promise<readonly EventEnvelope[]>;
  /**
   * Persists a snapshot at a committed event cursor. Its business version
   * must match that event. Identical retries are no-ops; different content
   * at the same cursor is a conflict. The latest snapshot has the highest seq.
   */
  saveSnapshot(projectId: string, snapshot: ProjectionSnapshot): Promise<void>;
  /** Loads the latest snapshot for a project; null when none exists. */
  loadSnapshot(projectId: string): Promise<ProjectionSnapshot | null>;
  /**
   * Marks events `[fromSeq, toSeq]` (inclusive) with a retention class —
   * a pure side-table annotation on the ledger, never a row write to the
   * event table and never a delete. Idempotent: re-marking the same event
   * with the same class is a no-op. An already-marked event keeps its
   * first class: a re-mark with a different class is a silent skip in
   * every adapter (first-write-wins — classification is decided once,
   * never re-classed, and the capture flow's ranges legitimately overlap
   * permanently-classified rows), so callers must not rely on a conflict
   * signal. Returns the seqs actually marked by this call
   * (already-marked events are not repeated), so the capture flow can
   * observe marks-first, snapshot-second.
   */
  markRetention(
    projectId: string,
    fromSeq: number,
    toSeq: number,
    retentionClass: RetentionClass,
  ): Promise<readonly number[]>;
}
