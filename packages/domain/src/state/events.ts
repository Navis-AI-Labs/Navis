import { z } from 'zod';
import { instantSchema } from '../schema/time.js';

/** Kernel events retain business time and version separately from append order. */
export const stateEventSchema = z
  .strictObject({
    seq: z.number().int().min(1),
    type: z.string().min(1).max(128),
    data: z.record(z.string(), z.json()),
    // acting Participant id; system-emitted events may omit the actor
    actor: z.string().min(1).max(512).nullable().optional(),
    // logical time supplied by the caller — the kernel never reads a clock
    at: instantSchema,
    // Project State version after this event; State-material events
    // increment it, everything else repeats the current version
    state_version: z.number().int().min(0),
    // envelope schema version, stamped by the kernel on every appended event
    schema_version: z.number().int().min(1),
  })
  .meta({
    description:
      'A kernel event record: seq, type, data, actor, logical at, and post-event state_version.',
    id: 'StateEvent',
  });

export type StateEvent = z.infer<typeof stateEventSchema>;
