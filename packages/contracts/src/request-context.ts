import { z } from 'zod';

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const traceIdPattern = /^(?!0{32}$)[0-9a-f]{32}$/;
const traceParentPattern =
  /^(?:00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-[0-9a-f]{2}|(?!(?:00|ff)-)[0-9a-f]{2}-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-[0-9a-f]{2}(?:-[0-9a-f]+)*)$/;
const traceStateKeyPattern =
  '(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})';
const traceStateValuePattern =
  '[\\x20-\\x2b\\x2d-\\x3c\\x3e-\\x7e]{0,255}[\\x21-\\x2b\\x2d-\\x3c\\x3e-\\x7e]';
const traceStateMemberPattern = `(?:${traceStateKeyPattern}=${traceStateValuePattern}|[ \\t]*)`;
const traceStatePattern = new RegExp(
  `^${traceStateMemberPattern}(?:[ \\t]*,[ \\t]*${traceStateMemberPattern}){0,31}$`,
);
const visibleAsciiPattern = /^[!-~]+$/;

/** Header names used to establish correlation and idempotency at a transport boundary. */
export const requestHeaderNames = {
  idempotencyKey: 'idempotency-key',
  requestId: 'x-request-id',
  traceParent: 'traceparent',
  traceState: 'tracestate',
} as const;

/** Opaque request correlation identifier. It is not a distributed trace identifier. */
export const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(requestIdPattern)
  .meta({ description: 'Opaque request correlation identifier.', id: 'RequestId' });

/** Lowercase W3C trace identifier, excluding the invalid all-zero value. */
export const traceIdSchema = z
  .string()
  .length(32)
  .regex(traceIdPattern)
  .meta({ description: 'W3C Trace Context trace-id.', id: 'TraceId' });

/** W3C traceparent value with version 00 and forward-compatible later versions. */
export const traceParentSchema = z
  .string()
  .min(55)
  .max(512)
  .regex(traceParentPattern)
  .meta({ description: 'W3C Trace Context traceparent field value.', id: 'TraceParent' });

/** W3C tracestate list syntax with bounded vendor entries. */
export const traceStateSchema = z
  .string()
  .max(512)
  .regex(traceStatePattern)
  .meta({ description: 'W3C Trace Context tracestate field value.', id: 'TraceState' });

/** Opaque identifier used to deduplicate one state-changing operation. */
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(visibleAsciiPattern)
  .meta({ description: 'Opaque operation idempotency key.', id: 'IdempotencyKey' });

/** Normalized request context after transport header extraction. */
export const requestContextSchema = z
  .strictObject({
    idempotency_key: idempotencyKeySchema.optional(),
    request_id: requestIdSchema,
    trace_parent: traceParentSchema.optional(),
    trace_state: traceStateSchema.optional(),
  })
  .meta({ description: 'Normalized transport request context.', id: 'RequestContext' });

export type RequestContext = z.infer<typeof requestContextSchema>;
