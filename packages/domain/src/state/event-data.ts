import { z } from 'zod';

import { acceptanceResultSchema } from '../schema/acceptance.js';
import { assetSchema } from '../schema/asset.js';
import { causalClockSnapshotSchema } from '../schema/causal-clock.js';
import { deliveryTargetTypeSchema } from '../schema/delivery.js';
import { holdKindSchema, holdSeveritySchema, holdStatusSchema } from '../schema/hold.js';
import { intendedDirectionStatusSchema } from '../schema/intended-direction.js';
import { participantTypeSchema } from '../schema/participant.js';
import { projectStatusSchema, stateVersionSchema } from '../schema/project.js';
import { uuidv7Schema } from '../schema/ids.js';
import { textSchema } from '../schema/text.js';
import { interventionModeSchema, workRunStatusSchema } from '../schema/workrun.js';
import { workStatusSchema } from '../schema/work.js';

const jsonRecord = z.record(z.string(), z.json());
const uuid = uuidv7Schema;
const reason = textSchema;
const actor = uuid;
const acceptanceCriteria = z.array(textSchema).max(100);

const checkpointPayload = z.strictObject({
  id: uuid,
  run_id: uuid.optional(),
  reason: textSchema.optional(),
  position: jsonRecord.optional(),
  resume_ref: z.record(z.string().min(1).max(128), z.string().max(2048)).optional(),
});

const candidateAsset = assetSchema.safeExtend({ lifecycle: z.literal('candidate') });
const effectSeed = z.strictObject({
  id: uuid,
  asset_ref: uuid.optional(),
  description: textSchema.optional(),
});

const schemas: Readonly<Record<string, z.ZodType>> = {
  'participant.registered': z.strictObject({
    participant_id: uuid,
    type: participantTypeSchema,
    display_name: z.string().min(1).max(256).optional(),
  }),
  'project.created': z.strictObject({
    project_id: uuid,
    title: z.string().min(1).max(256),
    purpose: textSchema.optional(),
    boundary: textSchema.optional(),
    acceptance_criteria: acceptanceCriteria.optional(),
  }),
  'project.policy_updated': z
    .strictObject({
      actor,
      reason,
      event_count_window: z.number().int().positive().optional(),
      time_window_days: z.number().positive().optional(),
    })
    .refine(
      (value) => value.event_count_window !== undefined || value.time_window_days !== undefined,
      {
        error: 'a policy update must carry at least one window',
      },
    ),
  'project.boundary_updated': z
    .strictObject({
      actor,
      reason,
      boundary: textSchema.optional(),
      acceptance_criteria: acceptanceCriteria.optional(),
    })
    .refine((value) => value.boundary !== undefined || value.acceptance_criteria !== undefined, {
      error: 'a boundary update must carry at least one field',
    }),
  'project.status_changed': z.strictObject({
    actor,
    from: projectStatusSchema,
    to: projectStatusSchema,
    reason,
  }),
  'work.created': z.strictObject({
    work_id: uuid,
    project_id: uuid,
    title: z.string().min(1).max(256),
    reason,
    direction: textSchema.optional(),
    acceptance_criteria: acceptanceCriteria.optional(),
    depends_on: z.array(uuid).max(100).optional(),
    actor,
  }),
  'work.redirected': z.strictObject({
    work_id: uuid,
    direction: textSchema,
    reason: reason.optional(),
    actor: actor.optional(),
    checkpoint: checkpointPayload.optional(),
  }),
  'work.status_changed': z.strictObject({
    work_id: uuid,
    from: workStatusSchema,
    to: workStatusSchema,
    reason: reason.optional(),
    cause: z.string().min(1).max(128).optional(),
    actor: actor.optional(),
  }),
  'asset.created': z.strictObject({
    asset: candidateAsset,
    actor,
  }),
  'asset.lifecycle_changed': z.strictObject({
    asset_id: uuid,
    from: z.enum([
      'candidate',
      'active',
      'superseded',
      'competitive_superseded',
      'deprecated',
      'archived',
      'rejected',
    ]),
    to: z.enum([
      'candidate',
      'active',
      'superseded',
      'competitive_superseded',
      'deprecated',
      'archived',
      'rejected',
    ]),
    reason: reason.optional(),
    actor: actor.optional(),
  }),
  'asset.purged': z.strictObject({
    asset_id: uuid,
    from: z.literal('archived'),
    to: z.literal('purged'),
    reason,
    actor,
  }),
  'acceptance.recorded': z
    .strictObject({
      acceptance_id: uuid,
      asset_id: uuid,
      result: acceptanceResultSchema,
      rationale: textSchema.optional(),
      criteria_snapshot: jsonRecord,
      evidence_refs: z.array(uuid).max(100).optional(),
      actor,
    })
    .refine((value) => value.result === 'accepted' || value.rationale !== undefined, {
      path: ['rationale'],
      error: 'rationale is required for this verdict',
    }),
  'hold.registered': z.strictObject({
    hold_id: uuid,
    project_id: uuid,
    kind: holdKindSchema,
    severity: holdSeveritySchema,
    initial_status: holdStatusSchema,
    blocks_delivery: z.boolean(),
    statement: textSchema,
    asset_refs: z.array(uuid).max(100).optional(),
    source_event_ids: z.array(z.string().min(1).max(128)).max(100).optional(),
    registered_during_work: uuid.optional(),
    applicability: textSchema.optional(),
    actor,
    registered_by: actor,
  }),
  'hold.activated': z.strictObject({
    hold_id: uuid,
    from: holdStatusSchema,
    to: z.literal('active'),
    actor,
    reason: reason.optional(),
    cause: z.string().min(1).max(128).optional(),
  }),
  'hold.resolved': z.strictObject({
    hold_id: uuid,
    from: holdStatusSchema,
    to: z.literal('resolved'),
    actor,
    reason: reason.optional(),
    cause: z.string().min(1).max(128).optional(),
  }),
  'hold.accepted': z.strictObject({
    hold_id: uuid,
    from: holdStatusSchema,
    to: z.literal('accepted'),
    actor,
    reason: reason.optional(),
    cause: z.string().min(1).max(128).optional(),
  }),
  'hold.dormanted': z.strictObject({
    hold_id: uuid,
    from: holdStatusSchema,
    to: z.literal('dormant'),
    actor,
    reason: reason.optional(),
    cause: z.string().min(1).max(128).optional(),
  }),
  'hold.invalidated': z.strictObject({
    hold_id: uuid,
    from: holdStatusSchema,
    to: z.literal('invalidated'),
    actor,
    reason: reason.optional(),
    cause: z.string().min(1).max(128).optional(),
  }),
  'checkpoint.created': z.strictObject({ id: uuid }),
  'equip.issued': z.strictObject({
    equip_id: uuid,
    state_version: stateVersionSchema,
    actor,
    work_id: uuid.optional(),
    participant_id: uuid,
    causal_snapshot: causalClockSnapshotSchema.optional(),
    allowed_actions: z.array(z.string().min(1).max(128)).max(100).optional(),
  }),
  'equip.budget_exceeded': z.strictObject({
    work_id: uuid.optional(),
    participant_id: uuid,
    fact_count: z.number().int().nonnegative(),
    serialized_length: z.number().int().nonnegative(),
    budget: z.number().int().positive(),
    actor,
  }),
  'return.absorbed': z.strictObject({
    equip_id: uuid,
    actor,
    candidates: z.array(candidateAsset).max(100),
    effects: z.array(effectSeed).max(100),
    verdict: z.enum(['dominates', 'dominated_by', 'concurrent', 'equal']).optional(),
    causal_context: causalClockSnapshotSchema.optional(),
    authoritative_clock: causalClockSnapshotSchema.optional(),
  }),
  'return.rejected': z.strictObject({
    equip_id: uuid,
    actor,
    equip_state_version: stateVersionSchema.nullable(),
    equip_status: z.string().min(1).max(64),
    current_state_version: stateVersionSchema,
    candidate_count: z.number().int().nonnegative(),
    effect_count: z.number().int().nonnegative(),
    verdict: z.enum(['dominates', 'dominated_by', 'concurrent', 'equal']).optional(),
    causal_context: causalClockSnapshotSchema.optional(),
    authoritative_clock: causalClockSnapshotSchema.optional(),
  }),
  'return.conflict_marked': z.strictObject({
    return_actor: actor,
    verdict: z.literal('concurrent'),
    causal_context: causalClockSnapshotSchema,
    authoritative_clock: causalClockSnapshotSchema,
  }),
  'effect.recorded': z.strictObject({
    effect_id: uuid,
    actor,
    asset_ref: uuid.optional(),
    description: textSchema.optional(),
  }),
  'effect.intent_recorded': z.strictObject({
    effect_id: uuid,
    intent_key: z.string().min(1).max(512),
    actor,
    asset_ref: uuid.optional(),
    description: textSchema.optional(),
  }),
  'effect.closed': z.strictObject({
    effect_id: uuid,
    outcome: z.enum(['confirmed', 'failed']),
    actor,
    reason: reason.optional(),
  }),
  'effect.cancel_recorded': z.strictObject({
    effect_id: uuid,
    actor,
    reason: reason.optional(),
  }),
  'effect.execution_begun': z.strictObject({
    effect_id: uuid,
    actor,
  }),
  'effect.execution_reset': z.strictObject({
    effect_id: uuid,
    actor,
    reason: textSchema,
    attempts_next: z.number().int().min(1),
  }),
  'delivery.recorded': z.strictObject({
    delivery_id: uuid,
    asset_id: uuid,
    target_ref: z.string().min(1).max(512),
    target_type: deliveryTargetTypeSchema,
    version: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
    attempt_no: z.number().int().positive().max(1000),
    delivered_by: actor,
    actor,
  }),
  'delivery.confirmed': z.strictObject({
    delivery_id: uuid,
    outcome: z.enum(['confirmed', 'rejected']),
    confirmed_by: actor,
    actor,
    feedback: textSchema.optional(),
  }),
  'direction.proposed': z.strictObject({
    direction_id: uuid,
    title: z.string().min(1).max(256),
    detail: z.string().min(1).max(4096).optional(),
  }),
  'direction.resolved': z.strictObject({
    direction_id: uuid,
    resolution: intendedDirectionStatusSchema.exclude(['proposed']),
    resolution_reason: z.string().min(1).max(4096),
  }),
  'workrun.started': z.strictObject({
    run_id: uuid,
    work_id: uuid,
    parent_run_id: uuid.optional(),
    attempt: z.number().int().positive().max(1000),
    execution_refs: z.record(z.string().min(1).max(128), z.string().max(2048)).optional(),
  }),
  'workrun.transitioned': z.strictObject({
    run_id: uuid,
    from: workRunStatusSchema,
    to: workRunStatusSchema,
    reason,
    run_revision: z.number().int().positive(),
    resume: z.boolean(),
    input_provided: textSchema.optional(),
    approval_result: textSchema.optional(),
    resume_checkpoint_id: uuid.optional(),
    checkpoint: checkpointPayload.optional(),
  }),
  'intervention.session_opened': z.strictObject({
    run_id: uuid,
    session_id: z.string().min(1).max(128),
    mode: interventionModeSchema,
    run_revision: z.number().int().positive(),
    consent_status: z.enum(['pending']).optional(),
  }),
  'intervention.session_closed': z.strictObject({
    run_id: uuid,
    session_id: z.string().min(1).max(128),
    was_takeover: z.boolean(),
    run_revision: z.number().int().positive(),
    consent_status: z.enum(['granted', 'denied']).optional(),
  }),
};

/** Parses the payload contract owned by one event family. */
export function parseEventData(type: string, data: unknown): Record<string, unknown> {
  const schema = schemas[type];
  if (schema === undefined) throw new Error(`unknown event type ${type}`);
  return schema.parse(data) as Record<string, unknown>;
}
