import { z } from 'zod';

import {
  instantWireSchema,
  labelWireSchema,
  textWireSchema,
  uuidRefSchema,
} from './wire-primitives.js';

/**
 * Canonical Work Event — the single envelope every adapter writes when a
 * signal crosses the boundary. The envelope carries extraction provenance
 * (source runtime, session, raw reference, extractor version, confidence,
 * human review state); `event_type` discriminates the payload. This shape
 * is the only runtime-validatable authority for these events: it is
 * re-declared here, never derived from server implementation types, and it
 * evolves additively (standard 06).
 */

/** The only canonical work event schema version this package supports. */
export const canonicalWorkEventSchemaVersion = 1;

/** Closed v1 event vocabulary; adding a value requires bumping the schema version. */
export const canonicalWorkEventTypeSchema = z.enum([
  'work.started',
  'work.progressed',
  'work.returned',
  'checkpoint.suggested',
  'evidence.captured',
  'candidate.proposed',
]);

/** Human review state of the extraction; distinct from extractor confidence. */
export const workEventReviewStatusSchema = z.enum(['pending', 'accepted', 'rejected']);

/* Raw-reference pointer (transcript/tool-log URI), up to 2048 chars. Used
 * by both the envelope and the evidence payload — one local shape keeps
 * the two sites from drifting. */
const rawRefSchema = z.string().min(1).max(2048);

/**
 * Envelope fields shared by every event variant. Extraction provenance is
 * mandatory (an event without provenance cannot be audited or fed into the
 * candidate→acceptance chain); `confidence` is machine uncertainty in
 * [0, 1] and must not be conflated with the human `review_status`.
 */
const envelopeShape = {
  schema_version: z.literal(canonicalWorkEventSchemaVersion),
  occurred_at: instantWireSchema,
  project_id: uuidRefSchema,
  source_runtime: labelWireSchema,
  source_session_id: z.string().min(1).max(128),
  raw_ref: rawRefSchema,
  extractor_version: z.string().min(1).max(64),
  confidence: z.number().min(0).max(1),
  review_status: workEventReviewStatusSchema,
} as const;

/** Payload for `work.started`: a bridge observed a unit of work beginning. */
const workStartedPayload = {
  work_id: uuidRefSchema,
  title: z.string().min(1).max(256).optional(),
  direction: textWireSchema.optional(),
} as const;

/** Payload for `work.progressed`: an interim progress signal on existing work. */
const workProgressedPayload = {
  work_id: uuidRefSchema,
  note: textWireSchema.optional(),
} as const;

/** Payload for `work.returned`: the work's result came back to be submitted. */
const workReturnedPayload = {
  work_id: uuidRefSchema,
  equip_id: uuidRefSchema.optional(),
  summary: textWireSchema.optional(),
} as const;

/** Payload for `checkpoint.suggested`: extraction suggests a checkpoint moment. */
const checkpointSuggestedPayload = {
  reason: textWireSchema,
  checkpoint_id: uuidRefSchema.optional(),
} as const;

/** Payload for `evidence.captured`: raw material that may seed candidates. */
const evidenceCapturedPayload = {
  raw_ref: rawRefSchema,
  note: textWireSchema.optional(),
} as const;

/** Payload for `candidate.proposed`: an extracted candidate seed before review. */
const candidateProposedPayload = {
  kind: textWireSchema,
  provenance: textWireSchema.optional(),
  content: z.json().optional(),
} as const;

/**
 * Builds the envelope union in one of two tolerances. Producer-strict
 * rejects undeclared fields everywhere; consumer-tolerant drops them.
 * This asymmetry is the additive-only evolution rule made mechanical: a
 * producer at version N never emits fields a version-N consumer has not
 * declared, and a consumer never fails on fields a newer compatible
 * producer added. Anything else bumps `schema_version`.
 */
function workEventSchemas(strict: boolean) {
  const object = strict ? z.strictObject : z.object;
  return z.discriminatedUnion('event_type', [
    object({
      ...envelopeShape,
      event_type: z.literal('work.started'),
      payload: object(workStartedPayload),
    }),
    object({
      ...envelopeShape,
      event_type: z.literal('work.progressed'),
      payload: object(workProgressedPayload),
    }),
    object({
      ...envelopeShape,
      event_type: z.literal('work.returned'),
      payload: object(workReturnedPayload),
    }),
    object({
      ...envelopeShape,
      event_type: z.literal('checkpoint.suggested'),
      payload: object(checkpointSuggestedPayload),
    }),
    object({
      ...envelopeShape,
      event_type: z.literal('evidence.captured'),
      payload: object(evidenceCapturedPayload),
    }),
    object({
      ...envelopeShape,
      event_type: z.literal('candidate.proposed'),
      payload: object(candidateProposedPayload),
    }),
  ]);
}

/** Consumer-tolerant schema: drops undeclared fields, keeps every declared one. */
export const canonicalWorkEventSchema = workEventSchemas(false).meta({
  description:
    'Canonical Work Event envelope (consumer-tolerant parsing drops undeclared fields; antecedent version check required).',
  id: 'CanonicalWorkEvent',
});

/** Producer-strict schema: rejects undeclared fields at every level. */
export const canonicalWorkEventStrictSchema = workEventSchemas(true).meta({
  description:
    'Canonical Work Event envelope (producer-strict: undeclared fields reject; producers never emit what consumers have not declared).',
  id: 'CanonicalWorkEventStrict',
});

export type CanonicalWorkEvent = z.infer<typeof canonicalWorkEventSchema>;

/**
 * Thrown when an event claims a schema version above what this consumer
 * supports. Version refusal is an explicit failure, never a partial parse.
 */
export class UnsupportedWorkEventVersionError extends Error {
  override readonly name = 'UnsupportedWorkEventVersionError' as const;
  readonly received: number;
  readonly supported: number;
  constructor(received: number, supported: number) {
    super(
      `unsupported schema_version: received ${String(received)}, supported up to ${String(supported)}`,
    );
    this.received = received;
    this.supported = supported;
  }
}

/* Version precheck: read just the version field; out-of-range ints are
 * refused before any payload interpretation happens. */
const versionProbeSchema = z.looseObject({
  schema_version: z.number().int().positive(),
});

function assertSupportedVersion(input: unknown): void {
  const probe = versionProbeSchema.safeParse(input);
  if (!probe.success) return; // malformed version falls through to the schema error
  if (probe.data.schema_version > canonicalWorkEventSchemaVersion) {
    throw new UnsupportedWorkEventVersionError(
      probe.data.schema_version,
      canonicalWorkEventSchemaVersion,
    );
  }
}

/** Producer path: validates against the strict schema; rejects undeclared fields. */
export function encodeCanonicalWorkEvent(input: unknown): CanonicalWorkEvent {
  assertSupportedVersion(input);
  return canonicalWorkEventStrictSchema.parse(input);
}

/** Consumer path: tolerates undeclared fields; refuses unsupported versions; unknown event_type at a supported version fails closed. */
export function parseCanonicalWorkEvent(input: unknown): CanonicalWorkEvent {
  assertSupportedVersion(input);
  return canonicalWorkEventSchema.parse(input);
}
