import { z } from 'zod';

import { textSchema } from './text.js';
import { instantSchema } from './time.js';
import { uuidSchema } from './ids.js';

/**
 * Checkpoint — a recoverable breakpoint during work execution.
 *
 * captured_at doubles as the birth stamp (this type is exempt from the
 * replay-cache quartet fields); state_version/position/resume_ref make the
 * breakpoint actually resumable — recovery needs a position, not just a
 * moment. redirect_work creates one by default before changing direction.
 */

export const checkpointSchema = z
  .strictObject({
    id: uuidSchema,
    work_id: uuidSchema, // ref Work
    reason: textSchema.optional(),
    captured_at: instantSchema, // when the breakpoint was captured
    // Project State version at capture; recovery restores against this anchor
    state_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    position: z.record(z.string().min(1).max(128), z.unknown()).optional(),
    resume_ref: z.record(z.string().min(1).max(128), z.string().max(2048)).optional(),
  })
  .meta({
    description: 'A recoverable breakpoint during work execution.',
    id: 'Checkpoint',
  });

export type Checkpoint = z.infer<typeof checkpointSchema>;
