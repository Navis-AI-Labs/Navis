import { z } from 'zod';

import { instantWireSchema, uuidRefSchema } from './wire-primitives.js';

/**
 * SessionStart hook — the contract emitted when a local runtime wants the
 * Bridge daemon up before any session work starts. The schema pins the
 * verb, the project_id it issues for, and the idempotency envelope request
 * id. Every other payload shape or verb is out of contract.
 */
export const bridgeHookInvocationSchema = z.strictObject({
  hook: z.literal('session.start'),
  project_id: uuidRefSchema,
  request_id: uuidRefSchema,
});
export type BridgeHookInvocation = z.infer<typeof bridgeHookInvocationSchema>;

/** Outcomes of a single hook invocation. */
export const bridgeHookResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('started'),
    pid: z.number().int().positive(),
    recorded_at: instantWireSchema,
  }),
  z.strictObject({
    status: z.literal('reused'),
    pid: z.number().int().positive(),
    recorded_at: instantWireSchema,
  }),
  z.strictObject({
    status: z.literal('failed'),
    reason: z.string().min(1).max(512),
    recorded_at: instantWireSchema,
  }),
]);
export type BridgeHookResult = z.infer<typeof bridgeHookResultSchema>;
