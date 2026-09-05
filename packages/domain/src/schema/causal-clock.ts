import { z } from 'zod';

import { uuidSchema } from './ids.js';

/**
 * Observed history: participant id -> count of that participant's events
 * seen. Travels on equips (bootstrap) and returns (causal_context).
 */

export const causalClockSnapshotSchema = z
  .record(uuidSchema, z.number().int().min(1).max(Number.MAX_SAFE_INTEGER))
  .meta({
    description:
      "Observed history: participant id -> count of that participant's events seen. Absent components compare as zero.",
    id: 'CausalClockSnapshot',
  });

export type CausalClockSnapshot = z.infer<typeof causalClockSnapshotSchema>;
