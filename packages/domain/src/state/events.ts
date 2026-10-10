import { z } from 'zod';
import { instantSchema } from '../schema/time.js';

/** Version of the persisted kernel event representation. */
export const STATE_EVENT_SCHEMA_VERSION = 1;

/** The closed event vocabulary the kernel emits. */
export const KERNEL_EVENT_TYPES = Object.freeze([
  'participant.registered',
  'project.created',
  'project.boundary_updated',
  'project.policy_updated',
  'project.status_changed',
  'work.created',
  'work.redirected',
  'work.status_changed',
  'asset.created',
  'asset.lifecycle_changed',
  'asset.purged',
  'acceptance.recorded',
  'hold.registered',
  'hold.activated',
  'hold.resolved',
  'hold.accepted',
  'hold.dormanted',
  'hold.invalidated',
  'checkpoint.created',
  'equip.issued',
  'equip.budget_exceeded',
  'return.absorbed',
  'return.rejected',
  'return.conflict_marked',
  'effect.recorded',
  'effect.intent_recorded',
  'effect.closed',
  'effect.cancel_recorded',
  'effect.execution_begun',
  'effect.execution_reset',
  'delivery.recorded',
  'delivery.confirmed',
  'direction.proposed',
  'direction.resolved',
  'workrun.started',
  'workrun.transitioned',
  'intervention.session_opened',
  'intervention.session_closed',
] as const);

export type KernelEventType = (typeof KERNEL_EVENT_TYPES)[number];

/** Only boundary and project-status changes invalidate an issued business context. */
const stateMaterialEvents: ReadonlySet<string> = new Set([
  'project.boundary_updated',
  'project.status_changed',
]);

export function isStateMaterialEvent(type: string): boolean {
  return stateMaterialEvents.has(type);
}

/** Validates non-kernel events synchronously; must be pure and throw on unknown types or invalid data. */
export type ObservationValidator = (type: string, data: unknown) => void;

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
