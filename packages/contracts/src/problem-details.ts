import { z } from 'zod';

import { requestIdSchema, traceIdSchema } from './request-context.js';

const uriReferencePattern = /^\S+$/;
const problemCodePattern = /^[A-Z][A-Z0-9_]{2,63}$/;
const jsonPointerPattern = /^(?:#(?:\/.*)?|\/.*)$/;

/** Media type registered by RFC 9457 for JSON Problem Details. */
export const problemDetailsMediaType = 'application/problem+json' as const;

/** One input issue in the validation-problem extension. */
export const validationProblemIssueSchema = z
  .looseObject({
    code: z.string().min(1).max(64).regex(problemCodePattern).optional(),
    detail: z.string().min(1).max(1024),
    pointer: z.string().min(1).max(1024).regex(jsonPointerPattern),
  })
  .meta({ description: 'One request validation issue.', id: 'ValidationProblemIssue' });

/** RFC 9457 Problem Details with safe, business-neutral project extensions. */
export const problemDetailsSchema = z
  .looseObject({
    code: z.string().min(3).max(64).regex(problemCodePattern).optional(),
    detail: z.string().min(1).max(4096).optional(),
    errors: z.array(validationProblemIssueSchema).max(100).optional(),
    instance: z.string().min(1).max(2048).regex(uriReferencePattern).optional(),
    request_id: requestIdSchema,
    status: z.int().min(100).max(599),
    title: z.string().min(1).max(256),
    trace_id: traceIdSchema.optional(),
    type: z.string().min(1).max(2048).regex(uriReferencePattern),
  })
  .meta({ description: 'RFC 9457 Problem Details response.', id: 'ProblemDetails' });

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type ValidationProblemIssue = z.infer<typeof validationProblemIssueSchema>;

/** Validates and creates an RFC 9457 Problem Details response. */
export function createProblemDetails(input: unknown): ProblemDetails {
  return problemDetailsSchema.parse(input);
}
