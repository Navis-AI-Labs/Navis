import { z } from 'zod';

import { contextSummarySchema } from './project-query.js';
import { instantWireSchema, uuidRefSchema } from './wire-primitives.js';

/**
 * SessionStart hook — the contract emitted when a local runtime wants the
 * Bridge daemon up before any session work starts.
 *
 * Revision (bridge-remote-sync-ingest): the daemon owns the project
 * decision. The caller no longer asserts `project_id`; it supplies the
 * working directory and the toml facts it observed, and the daemon resolves
 * the project from its binding table. A caller that cannot know the
 * project cannot claim it.
 *
 * Result grammar: `bound` (the session is attached to a project and its
 * context summary is served), `unbound` (no verified binding; the reason is
 * closed-vocabulary), `reused` (an idempotent repeat of a `request_id`
 * already answered — it returns the same event id and writes nothing).
 */

/** Closed vocabulary for why a session is unbound. */
export const bridgeHookUnboundReasons = {
  no_toml: 'no-navis-toml',
  project_unverified: 'project-unverified',
  member_denied: 'member-denied',
  daemon_unavailable: 'daemon-unavailable',
} as const;

/**
 * State-change marker for the context served with a `bound` result. An
 * unchanged project version yields `unchanged` and the summary is served
 * from the daemon's cache; `stale` marks an offline read with its cache
 * timestamp.
 */
export const bridgeHookStateChangeSchema = z.enum(['advanced', 'unchanged', 'stale']);

/**
 * Invocation shape. `cwd` is absolute and normalized; the daemon walks it
 * upward to find `navis.toml`. `toml_present` and `toml_project_id` report
 * what the caller observed — they are inputs to the daemon's decision, not
 * a trust basis: binding still requires server verification.
 */
export const bridgeHookInvocationSchema = z
  .strictObject({
    hook: z.literal('session.start'),
    request_id: uuidRefSchema,
    cwd: z.string().min(1).max(4096),
    toml_present: z.boolean(),
    toml_project_id: uuidRefSchema.optional(),
  })
  .refine((shape) => shape.toml_present || shape.toml_project_id === undefined, {
    message: 'toml_project_id requires toml_present',
    path: ['toml_project_id'],
  });
export type BridgeHookInvocation = z.infer<typeof bridgeHookInvocationSchema>;

/**
 * Structured context summary served with a `bound` result. Six fields, no
 * character cap: the caller consumes structure, not prose.
 */
export const bridgeHookContextSummarySchema = contextSummarySchema;

/**
 * Outcomes of a single hook invocation. `bound` and `unbound` are the two
 * first-invocation outcomes; `reused` is the idempotent replay of a
 * `request_id` the daemon already answered, returning the same `event_id`
 * and writing no new session event.
 */
export const bridgeHookResultSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      status: z.literal('bound'),
      bound_source: z.enum(['toml', 'binding-table', 'manual-link']),
      event_id: uuidRefSchema,
      project_id: uuidRefSchema,
      change_marker: bridgeHookStateChangeSchema,
      context_summary: bridgeHookContextSummarySchema.optional(),
      cached_at: instantWireSchema.optional(),
    })
    .meta({ description: 'Session bound to a verified project.', id: 'BridgeHookBound' }),
  z
    .strictObject({
      status: z.literal('unbound'),
      reason: z.enum([
        bridgeHookUnboundReasons.no_toml,
        bridgeHookUnboundReasons.project_unverified,
        bridgeHookUnboundReasons.member_denied,
        bridgeHookUnboundReasons.daemon_unavailable,
      ]),
    })
    .meta({ description: 'Session has no verified project binding.', id: 'BridgeHookUnbound' }),
  z
    .strictObject({
      status: z.literal('reused'),
      event_id: uuidRefSchema,
    })
    .meta({ description: 'Idempotent replay of an answered request.', id: 'BridgeHookReused' }),
]);
export type BridgeHookResult = z.infer<typeof bridgeHookResultSchema>;
