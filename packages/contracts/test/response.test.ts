import { describe, expect, it } from 'vitest';

import {
  createCursorPageResponse,
  createSuccessResponse,
  cursorPageResponseSchema,
  successResponseSchema,
} from '../src/response.js';

describe('success response contracts', () => {
  it('creates a typed success response with validated metadata', () => {
    const response = createSuccessResponse(
      { value: 42 },
      { request_id: 'request-1', trace_id: '4bf92f3577b34da6a3ce929d0e0e4736' },
    );

    expect(response).toEqual({
      data: { value: 42 },
      meta: { request_id: 'request-1', trace_id: '4bf92f3577b34da6a3ce929d0e0e4736' },
    });
  });

  it('rejects invalid shared response metadata', () => {
    expect(() => createSuccessResponse('value', { request_id: '' })).toThrow();
  });

  it('preserves additive response extensions for compatible evolution', () => {
    expect(
      successResponseSchema.parse({
        data: { value: 42 },
        extension: 'future',
        meta: { request_id: 'request-1', region: 'test' },
      }),
    ).toEqual({
      data: { value: 42 },
      extension: 'future',
      meta: { request_id: 'request-1', region: 'test' },
    });
  });

  it('creates a cursor page while keeping cursor contents opaque', () => {
    const response = createCursorPageResponse([{ id: 'one' }], {
      page: { has_more: true, next_cursor: 'opaque_cursor-2' },
      request_id: 'request-2',
    });

    expect(response).toEqual({
      data: [{ id: 'one' }],
      meta: {
        page: { has_more: true, next_cursor: 'opaque_cursor-2' },
        request_id: 'request-2',
      },
    });
    expect(cursorPageResponseSchema.safeParse(response).success).toBe(true);
  });

  it('rejects cursors with a public structure or unsafe query characters', () => {
    expect(() =>
      createCursorPageResponse([], {
        page: { has_more: false, next_cursor: '{"offset":2}' },
        request_id: 'request-3',
      }),
    ).toThrow();
  });
});
