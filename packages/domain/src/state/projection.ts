import { z } from 'zod';

import { assetSchema } from '../schema/asset.js';
import { causalClockSnapshotSchema } from '../schema/causal-clock.js';
import { holdSchema } from '../schema/hold.js';
import { projectSchema, stateVersionSchema } from '../schema/project.js';
import { workSchema } from '../schema/work.js';
import { workRunSchema, interventionSessionSchema } from '../schema/workrun.js';
import { instantSchema } from '../schema/time.js';
import { intendedDirectionSchema } from '../schema/intended-direction.js';
import { acceptanceSchema } from '../schema/acceptance.js';
import { deliverySchema } from '../schema/delivery.js';
import { participantSchema } from '../schema/participant.js';
import { checkpointSchema } from '../schema/checkpoint.js';
import { uuidSchema } from '../schema/ids.js';
import { textSchema } from '../schema/text.js';

const replayFields = {
  created_at: instantSchema,
  updated_at: instantSchema.optional(),
  updated_by: uuidSchema.nullable().optional(),
  deleted_at: instantSchema.optional(),
};

const participantRowSchema = z.strictObject({
  ...replayFields,
  id: uuidSchema,
  project_id: uuidSchema.optional(),
  type: participantSchema.shape.type,
  display_name: participantSchema.shape.display_name,
  role: participantSchema.shape.role,
});

const projectRowSchema = z.strictObject({
  ...replayFields,
  id: uuidSchema,
  title: projectSchema.shape.title,
  purpose: projectSchema.shape.purpose,
  boundary: projectSchema.shape.boundary,
  acceptance_criteria: projectSchema.shape.acceptance_criteria,
  status: projectSchema.shape.status,
  current_state_version: projectSchema.shape.current_state_version,
});

export const capturePolicySchema = z.strictObject({
  event_count_window: z.number().int().positive(),
  time_window_days: z.number().positive(),
});

const policyRowSchema = capturePolicySchema.extend({
  updated_at: instantSchema.optional(),
  updated_by: uuidSchema.nullable().optional(),
});

const workRowSchema = z.strictObject({
  ...replayFields,
  id: uuidSchema,
  project_id: uuidSchema,
  title: workSchema.shape.title,
  status: workSchema.shape.status,
  direction: workSchema.shape.direction,
  acceptance_criteria: workSchema.shape.acceptance_criteria,
  depends_on: workSchema.shape.depends_on,
  aggregate_revision: z.number().int().positive(),
});

const assetRowSchema = z.strictObject({
  ...replayFields,
  id: uuidSchema,
  kind: assetSchema.shape.kind,
  scope: assetSchema.shape.scope,
  project_id: assetSchema.shape.project_id,
  lifecycle: assetSchema.shape.lifecycle,
  provenance: assetSchema.shape.provenance,
  content: assetSchema.shape.content,
  valid_from: assetSchema.shape.valid_from,
  valid_to: assetSchema.shape.valid_to,
  archived_at: instantSchema.optional(),
  competitive_superseded_at: instantSchema.optional(),
});

const holdRowSchema = z.strictObject({
  ...replayFields,
  id: uuidSchema,
  project_id: uuidSchema,
  kind: holdSchema.shape.kind,
  severity: holdSchema.shape.severity,
  status: holdSchema.shape.status,
  blocks_delivery: holdSchema.shape.blocks_delivery,
  statement: holdSchema.shape.statement,
  fowler_quadrant: holdSchema.shape.fowler_quadrant,
  source_event_ids: holdSchema.shape.source_event_ids,
  registered_during_work: holdSchema.shape.registered_during_work,
  asset_refs: holdSchema.shape.asset_refs,
  registered_by: holdSchema.shape.registered_by,
  applicability: holdSchema.shape.applicability,
});

const acceptanceRowSchema = z
  .strictObject({
    id: uuidSchema,
    asset_id: uuidSchema,
    result: acceptanceSchema.shape.result,
    rationale: acceptanceSchema.shape.rationale,
    criteria_snapshot: acceptanceSchema.shape.criteria_snapshot,
    evidence_refs: acceptanceSchema.shape.evidence_refs,
    actor: acceptanceSchema.shape.actor,
    created_at: instantSchema,
    deleted_at: instantSchema.optional(),
  })
  // Field reuse must not drop the object-level constraint: rejected and
  // conditional verdicts still require a non-blank rationale, or a restored
  // snapshot could smuggle an acceptance the object schema would refuse.
  .refine(
    (row) =>
      (row.result !== 'rejected' && row.result !== 'conditional') ||
      (typeof row.rationale === 'string' && row.rationale.trim().length > 0),
    { path: ['rationale'], error: 'rationale is required when result is rejected or conditional' },
  );

const checkpointRowSchema = z.strictObject({
  id: uuidSchema,
  work_id: uuidSchema,
  run_id: uuidSchema.optional(),
  reason: checkpointSchema.shape.reason,
  captured_at: checkpointSchema.shape.captured_at,
  state_version: checkpointSchema.shape.state_version,
  position: checkpointSchema.shape.position,
  resume_ref: checkpointSchema.shape.resume_ref,
  deleted_at: instantSchema.optional(),
});

const deliveryRowSchema = z.strictObject({
  ...replayFields,
  id: uuidSchema,
  asset_id: uuidSchema,
  target_ref: deliverySchema.shape.target_ref,
  target_type: deliverySchema.shape.target_type,
  dispatched_at: deliverySchema.shape.dispatched_at,
  version: deliverySchema.shape.version,
  attempt_no: deliverySchema.shape.attempt_no,
  delivered_by: uuidSchema,
  confirmation_status: deliverySchema.shape.confirmation_status,
  confirmed_by: deliverySchema.shape.confirmed_by,
  confirmed_at: deliverySchema.shape.confirmed_at,
  feedback: deliverySchema.shape.feedback,
});

const effectRowSchema = z.strictObject({
  ...replayFields,
  id: uuidSchema,
  asset_ref: uuidSchema.optional(),
  description: textSchema.optional(),
  status: z.enum(['unknown', 'confirmed', 'failed']),
  closed_at: instantSchema.optional(),
});

const equipRowSchema = z.strictObject({
  id: uuidSchema,
  work_id: uuidSchema.optional(),
  participant_id: uuidSchema.optional(),
  state_version: stateVersionSchema,
  causal_snapshot: causalClockSnapshotSchema.optional(),
  status: z.enum(['active', 'stale']),
  created_at: instantSchema,
});

const runSessionRowSchema = interventionSessionSchema.extend({
  session_id: z.string().min(1).max(128),
});

const workRunRowSchema = z.strictObject({
  ...replayFields,
  id: uuidSchema,
  work_id: uuidSchema,
  parent_run_id: uuidSchema.optional(),
  status: workRunSchema.shape.status,
  run_revision: z.number().int().positive(),
  re_equip_required: z.boolean().optional(),
  intervention_mode: workRunSchema.shape.intervention_mode,
  intervention_sessions: z.array(runSessionRowSchema),
  checkpoint_id: uuidSchema.optional(),
  input_state_version: workRunSchema.shape.input_state_version,
  attempt: workRunSchema.shape.attempt,
  execution_refs: workRunSchema.shape.execution_refs,
});

const intendedDirectionRowSchema = z.strictObject({
  ...replayFields,
  id: uuidSchema,
  project_id: uuidSchema,
  title: intendedDirectionSchema.shape.title,
  detail: intendedDirectionSchema.shape.detail,
  status: intendedDirectionSchema.shape.status,
  proposed_by: uuidSchema,
  proposed_at: instantSchema,
  resolved_by: uuidSchema.optional(),
  resolved_at: instantSchema.optional(),
  resolution_reason: z.string().optional(),
});

function rows<T extends z.ZodType<{ id: string }>>(schema: T) {
  return z
    .record(uuidSchema, schema)
    .refine((values) => Object.entries(values).every(([id, row]) => id === row.id), {
      error: 'row key must match its identity',
    });
}

/** The replay cache has one runtime shape for live state and snapshot restoration. */
export const projectionSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  project: projectRowSchema.nullable(),
  policy: policyRowSchema.nullable(),
  participants: rows(participantRowSchema),
  works: rows(workRowSchema),
  assets: rows(assetRowSchema),
  holds: rows(holdRowSchema),
  acceptances: rows(acceptanceRowSchema),
  checkpoints: rows(checkpointRowSchema),
  deliveries: rows(deliveryRowSchema),
  effects: rows(effectRowSchema),
  equips: rows(equipRowSchema),
  work_runs: rows(workRunRowSchema),
  intended_directions: rows(intendedDirectionRowSchema),
});

type ReadonlyValue<T> = T extends object ? { readonly [K in keyof T]: ReadonlyValue<T[K]> } : T;

export type ParticipantRow = ReadonlyValue<z.infer<typeof participantRowSchema>>;
export type ProjectRow = ReadonlyValue<z.infer<typeof projectRowSchema>>;
export type PolicyRow = ReadonlyValue<z.infer<typeof policyRowSchema>>;
export type WorkRow = ReadonlyValue<z.infer<typeof workRowSchema>>;
export type AssetRow = ReadonlyValue<z.infer<typeof assetRowSchema>>;
export type HoldRow = ReadonlyValue<z.infer<typeof holdRowSchema>>;
export type AcceptanceRow = ReadonlyValue<z.infer<typeof acceptanceRowSchema>>;
export type CheckpointRow = ReadonlyValue<z.infer<typeof checkpointRowSchema>>;
export type DeliveryRow = ReadonlyValue<z.infer<typeof deliveryRowSchema>>;
export type EffectRow = ReadonlyValue<z.infer<typeof effectRowSchema>>;
export type EquipRow = ReadonlyValue<z.infer<typeof equipRowSchema>>;
export type WorkRunRow = ReadonlyValue<z.infer<typeof workRunRowSchema>>;
export type IntendedDirectionRow = ReadonlyValue<z.infer<typeof intendedDirectionRowSchema>>;
export type RunSessionRow = ReadonlyValue<z.infer<typeof runSessionRowSchema>>;
export type KernelProjection = ReadonlyValue<z.infer<typeof projectionSchema>>;
