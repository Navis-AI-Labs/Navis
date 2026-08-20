import { describe, expect, it } from 'vitest';

import {
  createProblemDetails,
  problemDetailsMediaType,
  problemDetailsSchema,
} from '../src/problem-details.js';

describe('Problem Details contracts', () => {
  it('uses the RFC 9457 media type', () => {
    expect(problemDetailsMediaType).toBe('application/problem+json');
  });

  it('creates Problem Details with safe project and validation extensions', () => {
    expect(
      createProblemDetails({
        code: 'INVALID_INPUT',
        detail: 'Correct the listed fields and retry.',
        errors: [{ code: 'REQUIRED', detail: 'A value is required.', pointer: '#/name' }],
        instance: '/problems/request-1',
        request_id: 'request-1',
        status: 422,
        title: 'Request validation failed',
        trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
        type: 'https://navis.example/problems/invalid-input',
      }),
    ).toMatchObject({
      code: 'INVALID_INPUT',
      request_id: 'request-1',
      status: 422,
      title: 'Request validation failed',
    });
  });

  it('preserves unknown extensions for forward compatibility', () => {
    expect(
      problemDetailsSchema.parse({
        request_id: 'request-2',
        retry_after_seconds: 10,
        status: 503,
        title: 'Temporarily unavailable',
        type: 'about:blank',
      }),
    ).toEqual({
      request_id: 'request-2',
      retry_after_seconds: 10,
      status: 503,
      title: 'Temporarily unavailable',
      type: 'about:blank',
    });
  });

  it('rejects invalid status, problem codes, and validation pointers', () => {
    const base = {
      request_id: 'request-3',
      status: 400,
      title: 'Bad Request',
      type: 'about:blank',
    };

    expect(problemDetailsSchema.safeParse({ ...base, status: 99 }).success).toBe(false);
    expect(problemDetailsSchema.safeParse({ ...base, code: 'invalid-code' }).success).toBe(false);
    expect(
      problemDetailsSchema.safeParse({
        ...base,
        errors: [{ detail: 'Invalid value.', pointer: 'name' }],
      }).success,
    ).toBe(false);
  });

  it('rejects invalid factory input', () => {
    expect(() => createProblemDetails({ title: 'Missing required fields' })).toThrow();
  });
});
