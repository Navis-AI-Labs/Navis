import { z } from 'zod';

import { schemaErrors, type SchemaError } from '../errors/index.js';
import { instantSchema } from './time.js';
import { uuidSchema } from './ids.js';

/**
 * WorkRun — a resumable business-work execution unit.
 *
 * The table below is the single authority on pair legality; takeover
 * exclusivity, presence, and consent rules live in `state/intervention.ts`
 * and reach the command surface through the kernel gates.
 */

export const workRunStatusSchema = z
  .enum([
    'ready',
    'running',
    'waiting_input',
    'waiting_approval',
    'paused',
    'cancelling',
    'cancelled',
    'failed',
    'completed',
  ])
  .meta({
    description: 'WorkRun lifecycle status (baseline nine-value enum).',
    id: 'WorkRunStatus',
  });

export const interventionModeSchema = z.enum(['observe', 'assist', 'takeover']).meta({
  description: 'Human intervention mode on a running work.',
  id: 'InterventionMode',
});

/**
 * One session on a run. The actor is named inside the session, never on
 * WorkRun itself; consent_status tracks the assist/takeover consent
 * lifecycle from `pending` to its terminal value.
 */
export const interventionSessionSchema = z
  .strictObject({
    participant_id: uuidSchema, // ref Participant
    mode: interventionModeSchema,
    started_at: instantSchema,
    ended_at: instantSchema.optional(),
    consent_status: z.enum(['granted', 'denied', 'pending']).optional(),
  })
  .meta({
    description: 'One human intervention session on a work run.',
    id: 'InterventionSession',
  });

/**
 * External execution references (runtime/adapter/device/capability/…):
 * an opaque JSONB bag — external protocol IDs are execution references,
 * never business keys.
 */
export const executionRefsSchema = z.record(z.string().min(1).max(128), z.string().max(2048)).meta({
  description: 'External execution references; opaque values, not business keys.',
  id: 'ExecutionRefs',
});

export const workRunSchema = z
  .strictObject({
    id: uuidSchema,
    deleted_at: instantSchema.nullable().optional(),
    // event-derived read cache; writable only by the projection replay path
    updated_at: instantSchema.nullable().optional(),
    updated_by: uuidSchema.nullable().optional(),
    created_at: instantSchema,
    work_id: uuidSchema, // ref Work
    parent_run_id: uuidSchema.optional(), // ref WorkRun; resumption chain
    status: workRunStatusSchema,
    // per-run optimistic-concurrency counter; transition and session commands
    // carry the previously observed value as their expected revision
    run_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    intervention_mode: interventionModeSchema.optional(),
    intervention_sessions: z.array(interventionSessionSchema).max(100).optional(),
    checkpoint_id: uuidSchema.optional(), // ref Checkpoint; resume position
    // project state version the run started from
    input_state_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    attempt: z.number().int().min(1).max(1000).optional(), // resumption attempt counter
    execution_refs: executionRefsSchema.optional(),
  })
  .meta({
    description: 'A resumable execution unit of a work, run by one participant (agent or human).',
    id: 'WorkRun',
  });

export type WorkRun = z.infer<typeof workRunSchema>;
export type InterventionMode = z.infer<typeof interventionModeSchema>;
export type InterventionSession = z.infer<typeof interventionSessionSchema>;
export type ExecutionRefs = z.infer<typeof executionRefsSchema>;

export type WorkRunStatus = z.infer<typeof workRunStatusSchema>;

/**
 * Legal transitions exactly as adopted: terminal states (`cancelled`,
 * `failed`, `completed`) have no outgoing pairs, `cancelling` only drains
 * to `cancelled`, and only `running` reaches a terminal state or a
 * waiting/paused intermediate.
 */
const LEGAL_RUN_TRANSITIONS: Readonly<Record<WorkRunStatus, readonly WorkRunStatus[]>> =
  Object.freeze({
    ready: Object.freeze(['running'] as const),
    running: Object.freeze([
      'waiting_input',
      'waiting_approval',
      'paused',
      'cancelling',
      'completed',
      'failed',
    ] as const),
    waiting_input: Object.freeze(['running', 'paused', 'cancelling'] as const),
    waiting_approval: Object.freeze(['running', 'paused', 'cancelling'] as const),
    paused: Object.freeze(['running', 'cancelling'] as const),
    cancelling: Object.freeze(['cancelled'] as const),
    cancelled: Object.freeze([] as const),
    failed: Object.freeze([] as const),
    completed: Object.freeze([] as const),
  });

export type RunTransitionResult =
  { readonly ok: true } | { readonly ok: false; readonly error: SchemaError };

/**
 * Checks a WorkRun transition against the legal-pair table. Gate evidence
 * (input, approval, resume checkpoint) is validated by the kernel command
 * layer; this function owns only the pair legality.
 */
export function assertWorkRunTransition(
  from: WorkRunStatus,
  to: WorkRunStatus,
): RunTransitionResult {
  if (!workRunStatusSchema.safeParse(from).success || !workRunStatusSchema.safeParse(to).success) {
    return { ok: false, error: schemaErrors.illegalTransition(from, to) };
  }
  const legal = LEGAL_RUN_TRANSITIONS[from];
  if (!legal.includes(to)) {
    return { ok: false, error: schemaErrors.illegalTransition(from, to) };
  }
  return { ok: true };
}
