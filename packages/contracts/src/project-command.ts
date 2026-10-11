import { z } from 'zod';
import {
  uuidRefSchema,
  textWireSchema,
  labelWireSchema,
  stateVersionWireSchema,
} from './wire-primitives.js';
import { returnSubmissionStrictSchema } from './return-contract.js';

const id = uuidRefSchema;
const reason = textWireSchema.refine((value) => value.trim().length > 0);
const record = z.record(z.string(), z.json());
const version = { expected_version: stateVersionWireSchema };
const effect = { effect_id: id, ...version };

/** Each operation owns its payload; identity and timestamps are never client fields. */
export const projectCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('work.create'),
    ...version,
    title: labelWireSchema,
    reason,
    direction: textWireSchema.optional(),
  }),
  z.strictObject({ type: z.literal('work.cancel'), ...version, work_id: id, reason }),
  z.strictObject({
    type: z.literal('work.redirect'),
    ...version,
    work_id: id,
    direction: textWireSchema,
    reason,
    create_checkpoint: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('project.boundary'),
    ...version,
    reason,
    boundary: textWireSchema.optional(),
    acceptance_criteria: z.array(textWireSchema).max(100).optional(),
  }),
  z.strictObject({
    type: z.literal('project.status'),
    ...version,
    reason,
    to: z.enum(['active', 'paused', 'completed', 'archived']),
  }),
  z.strictObject({
    type: z.literal('project.policy'),
    capture_privacy: z.enum(['metadata', 'local-only']).optional(),
    ...version,
    reason,
    event_count_window: z.int().positive().optional(),
    time_window_days: z.number().positive().optional(),
  }),
  z.strictObject({ type: z.literal('equip.issue'), ...version, work_id: id.optional() }),
  z
    .strictObject({ type: z.literal('return.submit'), ...returnSubmissionStrictSchema.shape })
    .meta({ proposal: true }),
  z
    .strictObject({
      type: z.literal('asset.propose'),
      ...version,
      kind: labelWireSchema,
      provenance: textWireSchema.optional(),
      content: z.json().optional(),
    })
    .meta({ proposal: true }),
  z.strictObject({
    type: z.literal('asset.accept'),
    ...version,
    asset_id: id,
    result: z.enum(['accepted', 'rejected', 'conditional']),
    rationale: reason.optional(),
    criteria_snapshot: record,
    evidence_refs: z.array(id).max(100).optional(),
  }),
  z.strictObject({
    type: z.literal('asset.transition'),
    ...version,
    asset_id: id,
    to: z.enum([
      'candidate',
      'active',
      'rejected',
      'superseded',
      'competitive_superseded',
      'deprecated',
      'archived',
      'purged',
    ]),
    reason,
    double_confirmation: z.boolean().optional(),
  }),
  z
    .strictObject({
      type: z.literal('hold.register'),
      ...version,
      kind: labelWireSchema,
      severity: labelWireSchema,
      statement: reason,
      blocks_delivery: z.boolean().optional(),
      asset_refs: z.array(id).max(100).optional(),
      registered_during_work: id.optional(),
    })
    .meta({ proposal: true }),
  z.strictObject({
    type: z.literal('hold.transition'),
    ...version,
    hold_id: id,
    to: z.enum(['registered', 'active', 'resolved', 'accepted', 'dormant', 'invalidated']),
    reason: reason.optional(),
  }),
  z.strictObject({
    type: z.literal('effect.intent'),
    ...version,
    intent_key: z.string().min(1).max(512),
    asset_ref: id.optional(),
    description: textWireSchema.optional(),
  }),
  z.strictObject({ type: z.literal('effect.begin'), ...effect }),
  z.strictObject({ type: z.literal('effect.reset'), ...effect, reason }),
  z.strictObject({
    type: z.literal('effect.close'),
    ...effect,
    outcome: z.enum(['confirmed', 'failed']),
    reason: reason.optional(),
  }),
  z.strictObject({ type: z.literal('effect.cancel'), ...effect, reason: reason.optional() }),
  z.strictObject({
    type: z.literal('delivery.record'),
    ...version,
    asset_id: id,
    target_ref: z.string().min(1).max(512),
    target_type: labelWireSchema,
  }),
  z.strictObject({
    type: z.literal('delivery.confirm'),
    ...version,
    delivery_id: id,
    outcome: z.enum(['confirmed', 'rejected']),
    feedback: textWireSchema.optional(),
  }),
  z
    .strictObject({
      type: z.literal('direction.propose'),
      ...version,
      direction_id: id,
      title: labelWireSchema,
      detail: textWireSchema.optional(),
    })
    .meta({ proposal: true }),
  z.strictObject({
    type: z.literal('direction.resolve'),
    ...version,
    direction_id: id,
    resolution: z.enum(['confirmed', 'discarded']),
    resolution_reason: reason,
  }),
  z.strictObject({
    type: z.literal('run.start'),
    ...version,
    run_id: id,
    work_id: id,
    equip_id: id,
    parent_run_id: id.optional(),
    execution_refs: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({
    type: z.literal('run.transition'),
    ...version,
    run_id: id,
    to: z.enum([
      'ready',
      'running',
      'waiting_input',
      'waiting_approval',
      'paused',
      'cancelling',
      'cancelled',
      'failed',
      'completed',
    ]),
    reason,
    run_revision: z.int().positive(),
    equip_id: id.optional(),
    input_provided: textWireSchema.optional(),
    approval_result: textWireSchema.optional(),
    resume_checkpoint_id: id.optional(),
    checkpoint_reason: reason.optional(),
    checkpoint_position: record.optional(),
    checkpoint_resume_ref: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({
    type: z.literal('intervention.open'),
    ...version,
    run_id: id,
    session_id: id,
    mode: z.enum(['observe', 'assist', 'takeover']),
    run_revision: z.int().positive(),
  }),
  z.strictObject({
    type: z.literal('intervention.close'),
    ...version,
    run_id: id,
    session_id: id,
    consent_status: z.enum(['granted', 'denied']).optional(),
    run_revision: z.int().positive(),
  }),
]);
export type ProjectCommand = z.infer<typeof projectCommandSchema>;

/** A proposal creates material for judgment; it never substitutes for human acceptance. */
export function projectCommandMode(type: ProjectCommand['type']): 'propose' | 'execute' {
  const schema = projectCommandSchema.options.find((option) => option.shape.type.value === type);
  return schema?.meta()?.['proposal'] === true ? 'propose' : 'execute';
}

export const createProjectRequestSchema = z.strictObject({
  project_id: id,
  title: labelWireSchema,
  purpose: textWireSchema.optional(),
  boundary: textWireSchema.optional(),
  acceptance_criteria: z.array(textWireSchema).max(100).optional(),
});
export const projectMemberRequestSchema = z.strictObject({
  participant_id: id,
  action: z.enum(['grant', 'revoke']),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type ProjectMemberRequest = z.infer<typeof projectMemberRequestSchema>;
