import { z } from 'zod';

import { textSchema } from './text.js';
import { instantSchema } from './time.js';
import { uuidSchema } from './ids.js';

/** Work — a real research, judgment, design, execution, verification, or delivery activity */

export const workStatusSchema = z
  .enum(['planned', 'in_progress', 'blocked', 'completed', 'cancelled'])
  .meta({ description: 'Work lifecycle status (baseline five-value enum).', id: 'WorkStatus' });

export const workSchema = z
  .strictObject({
    id: uuidSchema,
    created_at: instantSchema,
    deleted_at: instantSchema.nullable().optional(),
    updated_at: instantSchema.nullable().optional(),
    updated_by: uuidSchema.nullable().optional(),
    project_id: uuidSchema, // ref Project
    title: z.string().min(1).max(256),
    status: workStatusSchema,
    // redirect_work advances event seq and the Work revision, not project_state_version
    direction: textSchema.optional(),
    acceptance_criteria: z.array(textSchema).max(100).optional(),
    depends_on: z.array(uuidSchema).max(100).optional(), // refs Work
  })
  .meta({
    description:
      'A real work activity: research, judgment, design, execution, verification, or delivery.',
    id: 'Work',
  });

export type Work = z.infer<typeof workSchema>;
export type WorkStatus = z.infer<typeof workStatusSchema>;
