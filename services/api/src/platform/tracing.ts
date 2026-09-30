import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { requestContextSchema, requestIdSchema } from '@navis/contracts';

/**
 * W3C Trace Context extraction — the service-side end of the correlation chain.
 *
 * The bridge daemon carries a `traceparent` (and optionally `tracestate`) on
 * every request; the local Agent session, the daemon, and server-side handling
 * share one trace. Malformed input is discarded, never echoed back or repaired:
 * an unusable `traceparent` is ignored and the caller mints a fresh context,
 * which is what the W3C rule prescribes for invalid context.
 */

export type RequestContext = z.infer<typeof requestContextSchema>;

const traceParentPattern = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Version-00 traceparent shape; the authoritative wire grammar lives in contracts. */
const traceParentSchema = z.string().regex(traceParentPattern);

const traceStateSchema = z.string().max(512);

const traceIdSchema = z
  .string()
  .length(32)
  .regex(/^[0-9a-f]{32}$/);

function headerOne(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Extracts request context from transport headers, or returns `null` when the
 * request carries no usable correlation. The assembled object is validated
 * against the public contract schema so the inferred type and the wire stay one
 * source of truth.
 */
export function extractRequestContext(
  headers: Record<string, string | string[] | undefined>,
): RequestContext | null {
  const traceParent = headerOne(headers, 'traceparent');
  const requestId = headerOne(headers, 'x-request-id');
  if (traceParent === undefined && requestId === undefined) {
    return null;
  }

  let requestIdValue: string | undefined;
  if (requestId !== undefined) {
    const parsed = requestIdSchema.safeParse(requestId);
    requestIdValue = parsed.success ? parsed.data : undefined;
  }
  let traceParentValue: string | undefined;
  let traceStateValue: string | undefined;
  if (traceParent !== undefined) {
    const parsed = traceParentSchema.safeParse(traceParent);
    if (parsed.success) {
      traceParentValue = parsed.data;
      const traceState = headerOne(headers, 'tracestate');
      if (traceState !== undefined) {
        const state = traceStateSchema.safeParse(traceState);
        traceStateValue = state.success ? state.data : undefined;
      }
    }
  }
  if (requestIdValue === undefined && traceParentValue === undefined) {
    return null;
  }
  return requestContextSchema.parse({
    request_id: requestIdValue ?? randomUUID(),
    ...(traceParentValue !== undefined ? { trace_parent: traceParentValue } : {}),
    ...(traceStateValue !== undefined ? { trace_state: traceStateValue } : {}),
  });
}

/** Mints a fresh context for a request that arrived without a usable one. */
export function freshRequestContext(): RequestContext {
  return requestContextSchema.parse({ request_id: requestIdSchema.parse(randomUUID()) });
}

/**
 * The W3C trace-id carried inside a traceparent, or `undefined` when the parent
 * is absent or does not hold one. Correlation fields on responses and log lines
 * use the trace-id, not the full traceparent (standard 03).
 */
export function traceIdFromParent(traceParent: string | undefined): string | undefined {
  if (traceParent === undefined) {
    return undefined;
  }
  const part = traceParent.split('-')[1];
  return part !== undefined && traceIdSchema.safeParse(part).success ? part : undefined;
}
