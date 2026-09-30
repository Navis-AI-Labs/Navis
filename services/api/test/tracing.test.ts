import { describe, expect, it } from 'vitest';

import { requestIdSchema } from '@navis/contracts';

import {
  extractRequestContext,
  freshRequestContext,
  traceIdFromParent,
} from '../src/platform/tracing.js';

const TRACE_ID = 'a'.repeat(32);
const SPAN_ID = 'b'.repeat(16);
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

describe('extractRequestContext', () => {
  it('returns null when no correlation headers are present', () => {
    expect(extractRequestContext({})).toBe(null);
  });

  it('extracts a valid request id', () => {
    const context = extractRequestContext({ 'x-request-id': 'abc.123:4-5' });
    expect(context?.request_id).toBe('abc.123:4-5');
  });

  it('drops an invalid request id', () => {
    expect(extractRequestContext({ 'x-request-id': 'not valid!' })).toBe(null);
  });

  it('extracts traceparent and tracestate together', () => {
    const context = extractRequestContext({
      traceparent: TRACEPARENT,
      tracestate: 'vendor=opaque',
    });
    expect(context?.trace_parent).toBe(TRACEPARENT);
    expect(context?.trace_state).toBe('vendor=opaque');
  });

  it('drops an invalid traceparent along with its tracestate', () => {
    expect(extractRequestContext({ traceparent: 'garbage', tracestate: 'vendor=opaque' })).toBe(
      null,
    );
  });

  it('keeps the parent but drops an over-long tracestate', () => {
    const context = extractRequestContext({
      traceparent: TRACEPARENT,
      tracestate: 'x'.repeat(513),
    });
    expect(context?.trace_parent).toBe(TRACEPARENT);
    expect(context?.trace_state).toBeUndefined();
  });

  it('reads the first value of a repeated header', () => {
    const context = extractRequestContext({ 'x-request-id': ['a-1', 'b-2'] });
    expect(context?.request_id).toBe('a-1');
  });

  it('pairs a request id with a traceparent', () => {
    const context = extractRequestContext({
      'x-request-id': 'req-1',
      traceparent: TRACEPARENT,
    });
    expect(context?.request_id).toBe('req-1');
    expect(context?.trace_parent).toBe(TRACEPARENT);
  });
});

describe('freshRequestContext', () => {
  it('mints a request id that satisfies the public schema', () => {
    const context = freshRequestContext();
    expect(requestIdSchema.safeParse(context.request_id).success).toBe(true);
  });
});

describe('traceIdFromParent', () => {
  it('returns undefined without a parent', () => {
    expect(traceIdFromParent(undefined)).toBeUndefined();
  });

  it('returns the trace id inside a valid parent', () => {
    expect(traceIdFromParent(TRACEPARENT)).toBe(TRACE_ID);
  });

  it('returns undefined when the parent holds no trace id', () => {
    expect(traceIdFromParent('garbage')).toBeUndefined();
  });
});
