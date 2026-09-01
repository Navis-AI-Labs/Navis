import { z } from 'zod';

import { textSchema } from './text.js';
import { instantSchema } from './time.js';
import { uuidSchema } from './ids.js';

/** Project — a continuously-existing project with goals, boundary, and delivery continuity */

export const projectStatusSchema = z.enum(['active', 'paused', 'completed', 'archived']).meta({
  description: 'Project lifecycle status (baseline four-value enum).',
  id: 'ProjectStatus',
});

export const projectSchema = z
  .strictObject({
    id: uuidSchema,
    created_at: instantSchema,
    deleted_at: instantSchema.nullable().optional(),
    // event-derived read cache; writable only by the projection replay path
    updated_at: instantSchema.nullable().optional(),
    updated_by: uuidSchema.nullable().optional(),
    title: z.string().min(1).max(256),
    purpose: textSchema.optional(), // why this project exists
    boundary: textSchema.optional(),
    acceptance_criteria: z.array(textSchema).max(100).optional(),
    status: projectStatusSchema,
    // for concurrency checks and Equip invalidation; only State-material events advance it
    current_state_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .meta({
    description: 'A continuously-existing project with goals, boundary, and delivery continuity.',
    id: 'Project',
  });

export type Project = z.infer<typeof projectSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
