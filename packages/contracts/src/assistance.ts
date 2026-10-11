import { z } from 'zod';
import { uuidRefSchema, stateVersionWireSchema } from './wire-primitives.js';

export const assistanceRequestSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(16_000),
  expected_version: stateVersionWireSchema,
});
export const assistanceStatusSchema = z.object({
  job_id: uuidRefSchema,
  project_id: uuidRefSchema,
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  attempts: z.int().nonnegative(),
  result: z.json().nullable(),
  error: z.string().nullable(),
});
export type AssistanceRequest = z.infer<typeof assistanceRequestSchema>;
