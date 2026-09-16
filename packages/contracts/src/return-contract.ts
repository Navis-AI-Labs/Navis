import { z } from 'zod';

import { equipCausalSnapshotSchema } from './equip-contract.js';
import { problemDetailsSchema, type ProblemDetails } from './problem-details.js';
import {
  labelWireSchema,
  stateVersionWireSchema,
  textWireSchema,
  uuidRefSchema,
} from './wire-primitives.js';

/**
 * The Return submission contract. A return binds to the issued equip that
 * authorized it and to the project state version the returning work
 * observed; identity (`actor`) and time are injected by the serving edge
 * and are deliberately absent from the body — any caller attempting to
 * supply them is rejected as a forged field.
 *
 * Candidate seeds carry only `kind` + optional `provenance`/`content`:
 * `lifecycle` and `scope` are fixed by the server ('candidate' /
 * project-scoped) and are rejected here so a client can never forge them.
 */

/* assertNoForgedServerFields runs inside the strict parse: any of the
 * server-owned key names appearing at submission or seed level rejects the
 * whole payload before interpretation. */
const forgedFieldNames = ['actor', 'timestamp', 'at', 'lifecycle', 'scope'] as const;

/** Stable machine reason tokens carried on return rejections (Problem Details `code`). */
export const returnRejectionCodes = {
  versionConflict: 'RETURN_VERSION_CONFLICT',
} as const;

/** Problem type (URI-reference) for a stale-equip version conflict; stable and namespaced under the contract surface, never leaking the server's internal module names. */
export const returnVersionConflictType = 'urn:navis:problem:return-version-conflict' as const;

/** Rejection detail view: stable token, bounded numbers, no internal rows. */
export const returnRejectionDetailSchema = z
  .strictObject({
    reason: z.literal('version-conflict'),
    expected: stateVersionWireSchema,
    actual: stateVersionWireSchema,
  })
  .meta({
    description: 'Stable rejection detail for a version-conflicted return.',
    id: 'ReturnRejectionDetail',
  });

export type ReturnRejectionDetail = z.infer<typeof returnRejectionDetailSchema>;

/** Builds the Problem Details for a stale-equip version conflict; contains no server internals. */
export function createReturnVersionConflictProblem(input: {
  expected: number;
  actual: number;
  request_id: string;
}): ProblemDetails {
  return problemDetailsSchema.parse({
    type: returnVersionConflictType,
    title: 'Return rejected: version conflict',
    status: 409,
    code: returnRejectionCodes.versionConflict,
    detail: `expected state version ${String(input.expected)} but the project is at ${String(input.actual)}`,
    request_id: input.request_id,
  });
}

/** Candidate seed as accepted from a caller: kind + optional provenance/content, nothing server-owned. */
const candidateSeedShape = {
  kind: labelWireSchema,
  provenance: textWireSchema.optional(),
  content: z.json().optional(),
} as const;

/** Effect seed as accepted from a caller: optional asset reference + optional description. */
const effectSeedShape = {
  asset_ref: uuidRefSchema.optional(),
  description: textWireSchema.optional(),
} as const;

const forgedFieldMessage = `server-fixed fields must be absent (${forgedFieldNames.join(', ')})`;

/** True when the value object carries no server-fixed key. */
function hasNoForgedFields(value: Record<string, unknown>): boolean {
  return !forgedFieldNames.some((name) => name in value);
}

/** Producer-strict submission schema: undeclared and server-owned fields reject. */
export const returnSubmissionStrictSchema = z
  .strictObject({
    equip_id: uuidRefSchema,
    expected_version: stateVersionWireSchema,
    candidates: z
      .array(z.strictObject(candidateSeedShape).refine(hasNoForgedFields, forgedFieldMessage))
      .max(100)
      .optional(),
    effects: z
      .array(z.strictObject(effectSeedShape).refine(hasNoForgedFields, forgedFieldMessage))
      .max(100)
      .optional(),
    causal_context: equipCausalSnapshotSchema.optional(),
  })

  .refine(hasNoForgedFields, forgedFieldMessage)
  .meta({
    description:
      'Return submission (producer-strict): equips + version + seeds only; actor and time are edge-injected, never accepted from the body.',
    id: 'ReturnSubmissionStrict',
  });

/** Consumer-tolerant submission schema for read-side uses: unknown-but-harmless fields drop. */
export const returnSubmissionSchema = z
  .object({
    equip_id: uuidRefSchema,
    expected_version: stateVersionWireSchema,
    candidates: z
      .array(z.object(candidateSeedShape).refine(hasNoForgedFields, forgedFieldMessage))
      .max(100)
      .optional(),
    effects: z
      .array(z.object(effectSeedShape).refine(hasNoForgedFields, forgedFieldMessage))
      .max(100)
      .optional(),
    causal_context: equipCausalSnapshotSchema.optional(),
  })
  .refine(hasNoForgedFields, forgedFieldMessage)
  .meta({
    description: 'Return submission (consumer-tolerant: undeclared fields are stripped).',
    id: 'ReturnSubmission',
  });

/** Successful return result as the edge reports it. */
export const returnResultSchema = z
  .strictObject({
    absorbed_candidates: z.number().int().min(0),
    absorbed_effects: z.number().int().min(0),
    conflict_marked: z.literal(true).optional(),
  })
  .meta({
    description:
      'Return result: counts absorbed; conflict_marked mirrors the ledger verdict event, never embedded server rows.',
    id: 'ReturnResult',
  });

export type ReturnSubmission = z.infer<typeof returnSubmissionSchema>;
export type ReturnResult = z.infer<typeof returnResultSchema>;

/** Producer edge: the serving edge validates an incoming submission body (strict). */
export function parseReturnSubmission(input: unknown): ReturnSubmission {
  return returnSubmissionStrictSchema.parse(input);
}

/** Consumer path: read-side tooling parses a submission record tolerantly (drops undeclared envelope fields; forged server fields still reject). */
export function parseReturnSubmissionTolerant(input: unknown): ReturnSubmission {
  return returnSubmissionSchema.parse(input);
}
