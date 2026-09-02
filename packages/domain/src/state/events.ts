import { z } from 'zod';

/**
 * The kernel's event record: the in-memory runtime counterpart of the
 * storage envelope. Six semantic fields per the spec — seq (monotonic,
 * 1-based), type, data, actor, at (caller-supplied logical time), and
 * state_version (the Project State version AFTER this event). Events are
 * deep-frozen on append and compared via canonical JSON.
 */

export const stateEventSchema = z
  .strictObject({
    seq: z.number().int().min(1),
    type: z.string().min(1).max(128),
    data: z.record(z.string(), z.unknown()),
    // acting Participant id; system-emitted events may omit the actor
    actor: z.string().min(1).max(512).nullable().optional(),
    // logical time supplied by the caller — the kernel never reads a clock
    at: z.string(),
    // Project State version after this event; State-material events
    // increment it, everything else repeats the current version
    state_version: z.number().int().min(0),
  })
  .meta({
    description:
      'A kernel event record: seq, type, data, actor, logical at, and post-event state_version.',
    id: 'StateEvent',
  });

export type StateEvent = z.infer<typeof stateEventSchema>;
