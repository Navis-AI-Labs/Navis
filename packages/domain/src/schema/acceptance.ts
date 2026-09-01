import { z } from 'zod';

import { textSchema } from './text.js';
import { uuidSchema } from './ids.js';
import { instantSchema } from './time.js';

/**
 * Acceptance — a responsible party's verdict on a candidate.
 *
 * created_at is the record's birth stamp; the judgment moment and every later
 * change live in the Event History envelope.
 */

export const acceptanceResultSchema = z
  .enum(['accepted', 'rejected', 'conditional'])
  .meta({ description: 'Acceptance verdict (baseline three-value enum).', id: 'AcceptanceResult' });

export const acceptanceTargetTypeSchema = z.enum(['Asset']).meta({
  description: 'What is being accepted.',
  id: 'AcceptanceTargetType',
});

/**
 * Verdicts that demand a written rationale. Declared as a subset of the
 * result enum — add a fourth verdict and this fails to compile until a
 * maintainer decides whether the new verdict needs a reason.
 */
const RATIONALE_REQUIRED_RESULTS: Partial<Record<z.infer<typeof acceptanceResultSchema>, boolean>> =
  {
    rejected: true,
    conditional: true,
  };

export const acceptanceSchema = z
  .strictObject({
    id: uuidSchema,
    deleted_at: instantSchema.nullable().optional(),
    // event-derived read cache; writable only by the projection replay path
    updated_at: instantSchema.nullable().optional(),
    updated_by: uuidSchema.nullable().optional(),
    created_at: instantSchema,
    target_ref: uuidSchema,
    target_type: acceptanceTargetTypeSchema,
    actor: uuidSchema, // a Participant reference; the human-only rule is enforced above this layer
    result: acceptanceResultSchema,
    rationale: textSchema.optional(),
    // the criteria as of judgment time; the ledger must answer which criteria version applied
    criteria_snapshot: z.record(z.string(), z.unknown()),
    evidence_refs: z.array(uuidSchema).max(100).optional(), // evidence relied upon at judgment time
  })
  /** Baseline field rule: rejected/conditional carry a written reason; the issue lands on the rationale path for field-level error mapping. */
  .refine((v) => !RATIONALE_REQUIRED_RESULTS[v.result] || !!v.rationale, {
    path: ['rationale'],
    error: 'rationale is required when result is rejected or conditional',
  })
  .meta({
    description: 'A named human verdict — accepted / rejected / conditional — with its reason.',
    id: 'Acceptance',
  });

export type Acceptance = z.infer<typeof acceptanceSchema>;
export type AcceptanceResult = z.infer<typeof acceptanceResultSchema>;
export type AcceptanceTargetType = z.infer<typeof acceptanceTargetTypeSchema>;
