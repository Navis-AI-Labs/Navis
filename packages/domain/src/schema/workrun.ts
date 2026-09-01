import { z } from 'zod';

import { instantSchema } from './time.js';
import { uuidSchema } from './ids.js';

/**
 * WorkRun — a resumable business-work execution unit.
 *
 * The transition machine and takeover-exclusivity rules are not defined
 * here; this file defines the data shape only.
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
 * Session-record shape is this module's convention (the baseline declares
 * an array without fixing the inner shape); the executor is named
 * inside each session, not on WorkRun itself. consent_status records whether
 * the intervention was consented.
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
    intervention_mode: interventionModeSchema.optional(),
    intervention_sessions: z.array(interventionSessionSchema).max(100).optional(),
    checkpoint_id: uuidSchema.optional(), // ref Checkpoint; resume position
    // Project State version the run started from
    input_state_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    attempt: z.number().int().min(1).max(1000).optional(), // resumption attempt counter
    execution_refs: executionRefsSchema.optional(),
  })
  .meta({
    description: 'A resumable execution unit of a work, run by one participant (agent or human).',
    id: 'WorkRun',
  });

export type WorkRun = z.infer<typeof workRunSchema>;
export type WorkRunStatus = z.infer<typeof workRunStatusSchema>;
export type InterventionMode = z.infer<typeof interventionModeSchema>;
export type InterventionSession = z.infer<typeof interventionSessionSchema>;
export type ExecutionRefs = z.infer<typeof executionRefsSchema>;
