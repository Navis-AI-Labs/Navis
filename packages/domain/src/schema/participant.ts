import { z } from 'zod';

import { uuidSchema } from './ids.js';
import { instantSchema } from './time.js';

/**
 * Participant — the system's only actor identity: every event's actor and
 * every actor reference is a Participant ref.
 */

export const participantTypeSchema = z.enum(['human', 'agent']).meta({
  description: 'Participant kind: human or agent.',
  id: 'ParticipantType',
});

export const participantSchema = z
  .strictObject({
    id: uuidSchema,
    deleted_at: instantSchema.nullable().optional(),
    updated_at: instantSchema.nullable().optional(),
    updated_by: uuidSchema.nullable().optional(),
    created_at: instantSchema,
    project_id: uuidSchema, // ref Project
    type: participantTypeSchema,
    display_name: z.string().min(1).max(256).optional(),
    // descriptive role; authorization is separate policy, never derived from it
    role: z.string().min(1).max(128).optional(),
  })
  .meta({
    description: 'A project participant — human or agent; the only actor identity in the system.',
    id: 'Participant',
  });

export type Participant = z.infer<typeof participantSchema>;
export type ParticipantType = z.infer<typeof participantTypeSchema>;
