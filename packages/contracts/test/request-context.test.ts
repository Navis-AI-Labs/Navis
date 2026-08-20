import { describe, expect, it } from 'vitest';

import {
  idempotencyKeySchema,
  requestContextSchema,
  requestHeaderNames,
  requestIdSchema,
  traceIdSchema,
  traceParentSchema,
  traceStateSchema,
} from '../src/request-context.js';

const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const parentId = '00f067aa0ba902b7';

describe('request context contracts', () => {
  it('publishes normalized header names without conflating request and trace identity', () => {
    expect(requestHeaderNames).toEqual({
      idempotencyKey: 'idempotency-key',
      requestId: 'x-request-id',
      traceParent: 'traceparent',
      traceState: 'tracestate',
    });
  });

  it('accepts bounded request and idempotency identifiers', () => {
    expect(requestIdSchema.parse('request:01.test')).toBe('request:01.test');
    expect(idempotencyKeySchema.parse('operation_01:retry-2')).toBe('operation_01:retry-2');
  });

  it('rejects malformed or oversized opaque identifiers', () => {
    expect(requestIdSchema.safeParse('-starts-with-punctuation').success).toBe(false);
    expect(requestIdSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(idempotencyKeySchema.safeParse('contains whitespace').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('accepts W3C version 00 and forward-compatible traceparent values', () => {
    expect(traceParentSchema.parse(`00-${traceId}-${parentId}-01`)).toBe(
      `00-${traceId}-${parentId}-01`,
    );
    expect(traceParentSchema.parse(`01-${traceId}-${parentId}-03-abcd`)).toBe(
      `01-${traceId}-${parentId}-03-abcd`,
    );
  });

  it('rejects invalid trace identifiers and traceparent values', () => {
    expect(traceIdSchema.safeParse('0'.repeat(32)).success).toBe(false);
    expect(traceIdSchema.safeParse(traceId.toUpperCase()).success).toBe(false);
    expect(traceParentSchema.safeParse(`00-${traceId}-${parentId}-01-extra`).success).toBe(false);
    expect(traceParentSchema.safeParse(`ff-${traceId}-${parentId}-01`).success).toBe(false);
    expect(traceParentSchema.safeParse(`00-${'0'.repeat(32)}-${parentId}-01`).success).toBe(false);
    expect(traceParentSchema.safeParse(`00-${traceId}-${'0'.repeat(16)}-01`).success).toBe(false);
  });

  it('bounds tracestate and normalizes a strict request context', () => {
    expect(traceStateSchema.parse('vendor=value')).toBe('vendor=value');
    expect(traceStateSchema.parse('vendor=value, tenant@system=opaque value')).toBe(
      'vendor=value, tenant@system=opaque value',
    );
    expect(traceStateSchema.parse('')).toBe('');
    expect(traceStateSchema.safeParse('Vendor=value').success).toBe(false);
    expect(traceStateSchema.safeParse('vendor=value,broken').success).toBe(false);
    expect(traceStateSchema.safeParse('vendor=value,other=bad,value').success).toBe(false);
    expect(traceStateSchema.safeParse('a'.repeat(513)).success).toBe(false);

    expect(
      requestContextSchema.parse({
        idempotency_key: 'operation-1',
        request_id: 'request-1',
        trace_parent: `00-${traceId}-${parentId}-01`,
        trace_state: 'vendor=value',
      }),
    ).toEqual({
      idempotency_key: 'operation-1',
      request_id: 'request-1',
      trace_parent: `00-${traceId}-${parentId}-01`,
      trace_state: 'vendor=value',
    });
    expect(requestContextSchema.safeParse({ request_id: 'request-1', extra: true }).success).toBe(
      false,
    );
  });
});
