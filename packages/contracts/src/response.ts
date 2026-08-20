import { z } from 'zod';

import { requestIdSchema, traceIdSchema } from './request-context.js';

const opaqueCursorPattern = /^[A-Za-z0-9_-]+$/;

/** Common metadata for JSON success responses. */
export const responseMetadataSchema = z
  .looseObject({
    request_id: requestIdSchema,
    trace_id: traceIdSchema.optional(),
  })
  .meta({ description: 'Metadata common to JSON success responses.', id: 'ResponseMetadata' });

/** Opaque cursor navigation state for a collection page. */
export const cursorPageMetadataSchema = z
  .looseObject({
    has_more: z.boolean(),
    next_cursor: z.string().min(1).max(2048).regex(opaqueCursorPattern).optional(),
    previous_cursor: z.string().min(1).max(2048).regex(opaqueCursorPattern).optional(),
  })
  .meta({ description: 'Opaque cursor pagination metadata.', id: 'CursorPageMetadata' });

/** Metadata for a paginated JSON success response. */
export const paginatedResponseMetadataSchema = responseMetadataSchema
  .extend({ page: cursorPageMetadataSchema })
  .meta({
    description: 'JSON success response metadata with cursor pagination.',
    id: 'PaginatedResponseMetadata',
  });

/** Business-neutral JSON success response schema. */
export const successResponseSchema = z
  .looseObject({
    data: z.unknown(),
    meta: responseMetadataSchema,
  })
  .meta({ description: 'JSON success response envelope.', id: 'SuccessResponse' });

/** Business-neutral cursor-paginated JSON response schema. */
export const cursorPageResponseSchema = z
  .looseObject({
    data: z.array(z.unknown()),
    meta: paginatedResponseMetadataSchema,
  })
  .meta({ description: 'Cursor-paginated JSON success response.', id: 'CursorPageResponse' });

export type CursorPageMetadata = z.infer<typeof cursorPageMetadataSchema>;
export type PaginatedResponseMetadata = z.infer<typeof paginatedResponseMetadataSchema>;
export type ResponseMetadata = z.infer<typeof responseMetadataSchema>;

type SuccessResponseShape = z.infer<typeof successResponseSchema>;
type CursorPageResponseShape = z.infer<typeof cursorPageResponseSchema>;

export type SuccessResponse<T> = Readonly<Omit<SuccessResponseShape, 'data'> & { data: T }>;

export type CursorPageResponse<T> = Readonly<
  Omit<CursorPageResponseShape, 'data'> & { data: readonly T[] }
>;

/** Creates a JSON success response after validating its shared metadata. */
export function createSuccessResponse<T>(data: T, meta: unknown): SuccessResponse<T> {
  return { data, meta: responseMetadataSchema.parse(meta) };
}

/** Creates a cursor-paginated JSON response after validating its shared metadata. */
export function createCursorPageResponse<T>(
  data: readonly T[],
  meta: unknown,
): CursorPageResponse<T> {
  return { data, meta: paginatedResponseMetadataSchema.parse(meta) };
}
