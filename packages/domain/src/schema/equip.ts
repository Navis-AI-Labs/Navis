import { z } from 'zod';

import { uuidSchema } from './ids.js';

/**
 * Equip — the execution contract derived from a project state version and
 * issued to one participant.
 *
 * Assembled at generation time, never stored as independent business data.
 */

export const equipStatusSchema = z.enum(['active', 'stale', 'expired']).meta({
  description: 'Equip validity status against the current state version.',
  id: 'EquipStatus',
});

export const equipSchema = z
  .strictObject({
    id: uuidSchema,
    state_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    work_id: uuidSchema.optional(), // ref Work — the work this equip serves
    participant_id: uuidSchema.optional(), // ref Participant — who is equipped
    allowed_actions: z.array(z.string().min(1).max(128)).max(100).optional(),
    schema_snapshot_version: z.number().int().min(0).optional(),
    status: equipStatusSchema,
  })
  .meta({
    description:
      'The execution contract derived from a project state version and issued to one participant.',
    id: 'Equip',
  });

export type Equip = z.infer<typeof equipSchema>;
export type EquipStatus = z.infer<typeof equipStatusSchema>;
