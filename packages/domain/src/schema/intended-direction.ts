import { z } from 'zod';

import { uuidSchema } from './ids.js';
import { instantSchema } from './time.js';

/**
 * IntendedDirection — one record of the project's third time plane: what
 * the project intends to verify or change next. Kept separate from History
 * and Current State; a confirmed direction becomes material only through
 * later explicit commands (for example, creating a Work), never through the
 * resolution itself.
 *
 * Descriptive fields are immutable after creation; the only permitted state
 * change is the single terminal resolution. Resolution is human-only and
 * carries a mandatory reason.
 */

export const intendedDirectionStatusSchema = z.enum(['proposed', 'confirmed', 'discarded']).meta({
  description: 'Direction record status: proposed until the single terminal resolution.',
  id: 'IntendedDirectionStatus',
});

export const intendedDirectionSchema = z
  .strictObject({
    id: uuidSchema,
    deleted_at: instantSchema.nullable().optional(),
    // event-derived read cache; writable only by the projection replay path
    updated_at: instantSchema.nullable().optional(),
    updated_by: uuidSchema.nullable().optional(),
    created_at: instantSchema,
    project_id: uuidSchema, // ref Project
    title: z.string().min(1).max(256),
    detail: z.string().min(1).max(4096).optional(),
    status: intendedDirectionStatusSchema,
    proposed_by: uuidSchema, // ref Participant
    // logical time of the proposal, supplied by the caller
    proposed_at: instantSchema,
    // present only after the single terminal resolution (replay writes them)
    resolved_by: uuidSchema.nullable().optional(), // ref Participant
    resolved_at: instantSchema.nullable().optional(),
    resolution_reason: z.string().min(1).max(4096).nullable().optional(),
  })
  .meta({
    description:
      'A versioned direction record: proposed by any participant, resolved once by a human with a mandatory reason.',
    id: 'IntendedDirection',
  });

export type IntendedDirection = z.infer<typeof intendedDirectionSchema>;
export type IntendedDirectionStatus = z.infer<typeof intendedDirectionStatusSchema>;
