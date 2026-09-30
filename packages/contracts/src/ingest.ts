import { z } from 'zod';

import { uuidRefSchema } from './wire-primitives.js';

/**
 * Ingest contract — the batch upload surface the bridge daemon calls to push
 * buffered Canonical Work Events into a project's event ledger.
 *
 * The batch is the unit of transport; the event is the unit of outcome. A
 * batch NEVER fails as a whole because some events are malformed: the
 * response reports per-event acceptance, per-event rejection with a stable
 * token, and per-event duplicate status, so the daemon can advance its
 * Outbox for what landed and quarantine only what did not.
 *
 * Every event in the batch carries its own envelope (Canonical Work Event
 * shape); the batch envelope carries only what is shared: the device that
 * authored the events and the contract versions negotiated up front.
 */

/** The ingest contract version this package supports. */
export const ingestContractSchemaVersion = 1;

/** Closed vocabulary for one event's outcome in a batch response. */
export const ingestEventOutcomeSchema = z.enum(['accepted', 'rejected', 'duplicate']);

/**
 * Stable machine-readable rejection tokens. A token is part of the public
 * contract: renaming or reusing one is a breaking change. Human detail
 * belongs in `detail`, which clients never parse.
 */
export const ingestRejectionTokens = {
  schema_version_unsupported: 'ingest/schema-version-unsupported',
  schema_violation: 'ingest/schema-violation',
  payload_hash_mismatch: 'ingest/payload-hash-mismatch',
  authorization_denied: 'ingest/authorization-denied',
  ledger_conflict: 'ingest/ledger-conflict',
} as const;

export type IngestRejectionToken = keyof typeof ingestRejectionTokens;

/** One rejection entry: the index of the offending event in the batch, a stable token, and the offending path. */
export const ingestRejectionSchema = z
  .strictObject({
    index: z.number().int().min(0),
    token: z.enum(ingestRejectionTokens),
    detail: z.string().min(1).max(1024).optional(),
    path: z.string().min(1).max(1024).optional(),
  })
  .meta({
    description: 'Per-event rejection inside an ingest batch response.',
    id: 'IngestRejection',
  });

/** One event's outcome inside a batch response, keyed by its batch index. */
export const ingestEventResultSchema = z
  .strictObject({
    index: z.number().int().min(0),
    outcome: ingestEventOutcomeSchema,
    rejection: ingestRejectionSchema.optional(),
  })
  .meta({ description: 'Per-event outcome in an ingest batch response.', id: 'IngestEventResult' });

/**
 * Per-event integrity claim. When the project enables server-side payload
 * verification, the service hashes the event payload and compares it against
 * this claim; a mismatch rejects the event with `payload-hash-mismatch`.
 */
export const ingestEventHashClaimSchema = z
  .strictObject({
    algorithm: z.literal('sha256'),
    value: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
  })
  .meta({ description: 'Per-event payload integrity claim.', id: 'IngestEventHashClaim' });

/**
 * One event in an ingest batch. The envelope is the Canonical Work Event
 * envelope; this wrapper carries only the ingest-specific claims the
 * envelope does not own: the event identity the daemon assigned at
 * capture, the causation link to the preceding event, the integrity claim,
 * and the batch-local index used in the response.
 *
 * Identity lives here rather than in the canonical envelope because it is a
 * ledger concern: the server deduplicates on `(event_id, device_id)`, so a
 * re-send of an already-acknowledged batch is a no-op at the server.
 */
export const ingestEventSchema = z
  .object({
    event_id: uuidRefSchema,
    causation_id: uuidRefSchema.optional(),
    event: z.unknown(),
    payload_hash: ingestEventHashClaimSchema.optional(),
  })
  .strip()
  .meta({ description: 'One event in an ingest batch.', id: 'IngestEvent' });

/**
 * The ingest request. `contract_version` is negotiated before any event is
 * interpreted: an unsupported version refuses the whole request without
 * touching a single payload, so a version skew can never cause partial
 * silent interpretation.
 */
export const ingestRequestSchema = z
  .strictObject({
    contract_version: z.literal(ingestContractSchemaVersion),
    event_schema_version: z.number().int().min(1),
    device_id: uuidRefSchema,
    events: z.array(ingestEventSchema).min(1).max(500),
  })
  .meta({ description: 'Ingest batch upload request.', id: 'IngestRequest' });

/**
 * The ingest response. Counts are authoritative for the daemon's Outbox
 * bookkeeping; per-event results are authoritative for which records to
 * advance, quarantine, or retry.
 */
export const ingestResponseSchema = z
  .looseObject({
    contract_version: z.literal(ingestContractSchemaVersion),
    accepted: z.array(z.number().int().min(0)),
    rejected: z.array(ingestRejectionSchema),
    duplicate: z.array(z.number().int().min(0)),
    event_results: z.array(ingestEventResultSchema),
    server_supported_contract_versions: z.array(z.number().int().min(1)),
    server_supported_event_schema_versions: z.array(z.number().int().min(1)),
  })
  .meta({ description: 'Ingest batch upload response.', id: 'IngestResponse' });

export type IngestRequest = z.infer<typeof ingestRequestSchema>;
export type IngestResponse = z.infer<typeof ingestResponseSchema>;
export type IngestRejection = z.infer<typeof ingestRejectionSchema>;
export type IngestEventResult = z.infer<typeof ingestEventResultSchema>;

/**
 * Thrown when a request declares a contract version above what this package
 * supports. Version refusal is an explicit failure — never partial parsing.
 */
export class UnsupportedIngestContractVersionError extends Error {
  override readonly name = 'UnsupportedIngestContractVersionError' as const;
  readonly received: number;
  readonly supported: number;
  constructor(received: number, supported: number) {
    super(
      `unsupported contract_version: received ${String(received)}, supported up to ${String(supported)}`,
    );
    this.received = received;
    this.supported = supported;
  }
}

/* Version precheck: refuse an unsupported contract version before any event
 * payload is read. */
const contractVersionProbeSchema = z.looseObject({
  contract_version: z.number().int().positive(),
});

/** Consumer path: validates the batch envelope; per-event validation happens per event, not per batch. */
export function parseIngestRequest(input: unknown): IngestRequest {
  const probe = contractVersionProbeSchema.safeParse(input);
  if (probe.success && probe.data.contract_version > ingestContractSchemaVersion) {
    throw new UnsupportedIngestContractVersionError(
      probe.data.contract_version,
      ingestContractSchemaVersion,
    );
  }
  return ingestRequestSchema.parse(input);
}

/** Producer path for a batch response. */
export function encodeIngestResponse(input: unknown): IngestResponse {
  return ingestResponseSchema.parse(input);
}
