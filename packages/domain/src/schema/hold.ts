import { z } from 'zod';

import { textSchema } from './text.js';
import { instantSchema } from './time.js';
import { uuidSchema } from './ids.js';

/**
 * Hold — a withheld concern on the delivery path.
 *
 * Three semantic fields split the concern: statement carries the problem
 * itself (the "what"), source_event_ids the evidence (the "why"), and
 * applicability where it still applies (the "when/where").
 * No resolved_at: the resolution timeline lives in the Event History.
 */

export const holdKindSchema = z
  .enum([
    'bug',
    'tech_debt',
    'deferred_decision',
    'unvalidated_assumption',
    'known_risk',
    'skipped_edge_case',
  ])
  .meta({
    description: 'What is being withheld (baseline six-value enum, extensible).',
    id: 'HoldKind',
  });

export const holdSeveritySchema = z
  .enum(['critical', 'high', 'medium', 'low', 'info'])
  .meta({ description: 'Hold severity (baseline five-level enum).', id: 'HoldSeverity' });

export const holdStatusSchema = z
  .enum(['registered', 'active', 'resolved', 'accepted', 'dormant', 'invalidated'])
  .meta({ description: 'Hold lifecycle status (baseline six-state enum).', id: 'HoldStatus' });

export const fowlerQuadrantSchema = z
  .enum([
    'prudent_deliberate',
    'prudent_inadvertent',
    'reckless_deliberate',
    'reckless_inadvertent',
  ])
  .meta({ description: 'Fowler debt quadrant classification.', id: 'FowlerQuadrant' });

export const holdSchema = z
  .strictObject({
    id: uuidSchema,
    deleted_at: instantSchema.nullable().optional(),
    updated_at: instantSchema.nullable().optional(),
    updated_by: uuidSchema.nullable().optional(),
    created_at: instantSchema,
    project_id: uuidSchema, // ref Project
    kind: holdKindSchema,
    severity: holdSeveritySchema,
    status: holdStatusSchema,
    fowler_quadrant: fowlerQuadrantSchema.optional(),
    blocks_delivery: z.boolean().default(false),
    // the problem itself; the registration action's required description lands here
    statement: textSchema,
    source_event_ids: z.array(z.string().min(1).max(128)).max(100).optional(),
    registered_during_work: uuidSchema.optional(), // ref Work
    // the registration actor; the human-confirmation fact is the activate event's actor
    registered_by: uuidSchema, // ref Participant
    asset_refs: z.array(uuidSchema).max(100).optional(), // refs Asset
    // where the hold still applies (stage/conditions); distinct from Asset validity
    applicability: textSchema.optional(),
  })
  /** fowler_quadrant classifies debt; other hold kinds have no debt quadrant. */
  .refine((v) => !v.fowler_quadrant || v.kind === 'tech_debt', {
    path: ['fowler_quadrant'],
    error: 'fowler_quadrant is only valid when kind is tech_debt',
  })
  .meta({
    description:
      'A withheld concern on the delivery path: registered, activated by a human, and resolved with reasons.',
    id: 'Hold',
  });

export type Hold = z.infer<typeof holdSchema>;
export type HoldKind = z.infer<typeof holdKindSchema>;
export type HoldSeverity = z.infer<typeof holdSeveritySchema>;
export type HoldStatus = z.infer<typeof holdStatusSchema>;
export type FowlerQuadrant = z.infer<typeof fowlerQuadrantSchema>;
