import { z } from 'zod';

import { uuidSchema } from './ids.js';
import { instantSchema } from './time.js';

/**
 * TaskSpace — the shared working context of one work, exactly id + work_id.
 *
 * Identity anchor plus the governed field quartet; context, participants,
 * and checkpoints are not part of this type.
 */

export const taskspaceSchema = z
  .strictObject({
    id: uuidSchema,
    deleted_at: instantSchema.nullable().optional(),
    updated_at: instantSchema.nullable().optional(),
    updated_by: uuidSchema.nullable().optional(),
    created_at: instantSchema,
    work_id: uuidSchema, // ref Work
  })
  .meta({
    description:
      'The shared working context of one work. Carries only the identity anchor (id + work_id); context, participants, and checkpoints are not part of this type.',
    id: 'TaskSpace',
  });

export type TaskSpace = z.infer<typeof taskspaceSchema>;
