import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  BadRequestError,
  InternalServerError,
  MethodNotAllowedError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  problemType,
  toProblemDetails,
  toValidationProblem,
} from '../src/platform/errors.js';

describe('problemType', () => {
  it('builds a stable URN for a machine code', () => {
    expect(problemType('BAD_REQUEST')).toBe('urn:navis:problem:bad_request');
  });
});

describe('toProblemDetails', () => {
  it('maps a service error with detail and correlation', () => {
    const problem = toProblemDetails(new BadRequestError('Malformed body.'), {
      request_id: 'req-1',
      trace_id: 'a'.repeat(32),
    });
    expect(problem.status).toBe(400);
    expect(problem.code).toBe('BAD_REQUEST');
    expect(problem.title).toBe('Bad Request');
    expect(problem.detail).toBe('Malformed body.');
    expect(problem.request_id).toBe('req-1');
    expect(problem.trace_id).toBe('a'.repeat(32));
    expect(problem.type).toBe('urn:navis:problem:bad_request');
  });

  it('maps every service status class', () => {
    expect(toProblemDetails(new NotFoundError(), { request_id: 'r' }).status).toBe(404);
    expect(toProblemDetails(new MethodNotAllowedError(['GET']), { request_id: 'r' }).status).toBe(
      405,
    );
    expect(toProblemDetails(new PayloadTooLargeError(100), { request_id: 'r' }).status).toBe(413);
    expect(toProblemDetails(new ServiceUnavailableError(), { request_id: 'r' }).status).toBe(503);
    expect(
      toProblemDetails(new InternalServerError(new Error('x')), { request_id: 'r' }).status,
    ).toBe(500);
  });

  it('carries the allow header description on 405', () => {
    const problem = toProblemDetails(new MethodNotAllowedError(['GET', 'POST']), {
      request_id: 'r',
    });
    expect(problem.detail).toBe('Allowed: GET, POST');
  });

  it('reports the byte limit on 413', () => {
    const problem = toProblemDetails(new PayloadTooLargeError(1024), { request_id: 'r' });
    expect(problem.detail).toBe('Request body exceeds the 1024-byte limit.');
  });

  it('omits detail when the error carries none', () => {
    expect(toProblemDetails(new NotFoundError(), { request_id: 'r' }).detail).toBeUndefined();
  });

  it('maps an unknown error to a detail-free 500 that never echoes the message', () => {
    const problem = toProblemDetails(new Error('secret internals: token=abc'), {
      request_id: 'r',
    });
    expect(problem.status).toBe(500);
    expect(problem.detail).toBeUndefined();
    expect(JSON.stringify(problem)).not.toContain('secret internals');
  });
});

describe('toValidationProblem', () => {
  it('maps a zod error to a 400 with one issue per offending path', () => {
    const schema = z.object({ name: z.string(), count: z.number() });
    const result = schema.safeParse({ name: 1, count: 'x' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const problem = toValidationProblem(result.error, { request_id: 'r' });
      expect(problem.status).toBe(400);
      expect(problem.code).toBe('BAD_REQUEST');
      expect(problem.errors).toHaveLength(2);
    }
  });

  it('carries the trace id when the request had one', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const traceId = 'a'.repeat(32);
      const problem = toValidationProblem(result.error, { request_id: 'r', trace_id: traceId });
      expect(problem.trace_id).toBe(traceId);
    }
  });

  it('emits a JSON pointer per issue', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const problem = toValidationProblem(result.error, { request_id: 'r' });
      expect(problem.errors?.[0]?.pointer).toBe('/name');
    }
  });

  it('bounds untrusted issue paths and messages', () => {
    const longKey = 'k'.repeat(2000);
    const schema = z.object({ [longKey]: z.string() });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const problem = toValidationProblem(result.error, { request_id: 'r' });
      const pointer = problem.errors?.[0]?.pointer;
      expect(pointer).toBeDefined();
      if (pointer !== undefined) {
        expect(pointer.length).toBeLessThanOrEqual(1024);
      }
    }
  });
});
