import { createHash } from 'node:crypto';

import {
  ingestRejectionTokens,
  parseCanonicalWorkEvent,
  UnsupportedWorkEventVersionError,
  type CanonicalWorkEvent,
  type IngestEventResult,
  type IngestRejection,
} from '@navis/contracts';
import { canonicalJson, eventEnvelopeSchema } from '@navis/domain';
import type { EventEnvelope, EventStore } from '@navis/domain';
import { ZodError as ZodErrorValue, type ZodError } from 'zod';

/**
 * Batch ingest use case — the semantics behind `POST /api/ingest` (spec
 * requirement: ingest accepts event batches and deduplicates on
 * (event_id, device_id)).
 *
 * The batch is the unit of transport; the event is the unit of outcome. A
 * malformed event never fails its siblings: every event is validated on its
 * own, duplicates are acknowledged without error, and the survivors append in
 * ONE ledger call, so an append is atomic per batch (standard 07). A version
 * the service does not support is refused per event, never interpreted.
 */

/** Session-internal events are metadata-only by construction; the rest carry content. */
const AUDIT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user.message',
  'agent.message',
  'tool.call.requested',
  'tool.call.result',
  'checkpoint.suggested',
]);

/** The privacy class a stored event carries, derived from its type family. */
function privacyClassFor(eventType: string): 'evidence' | 'work' | 'audit' {
  if (AUDIT_EVENT_TYPES.has(eventType)) return 'audit';
  if (eventType === 'evidence.captured') return 'evidence';
  return 'work';
}

/** Ports the use case needs; concrete adapters are injected, never imported. */
export interface IngestBatchDeps {
  readonly eventStore: EventStore;
  /** Per-project switch for server-side payload verification (G7). */
  readonly verifyPayloadHash: boolean;
  /** Receipt time for the ledger's `recorded_at`; the kernel never reads a clock. */
  readonly now: () => string;
}

/** One event as the transport handed it over: identity, causation, envelope, integrity claim. */
export interface IngestEventInput {
  readonly event_id: string;
  readonly causation_id?: string | undefined;
  readonly event: unknown;
  readonly payload_hash?: { readonly algorithm: 'sha256'; readonly value: string } | undefined;
}

export interface IngestBatchRequest {
  readonly deviceId: string;
  readonly events: readonly IngestEventInput[];
}

export interface IngestBatchResponse {
  /** The one project this batch belongs to; null when no event survived validation. */
  readonly projectId: string | null;
  readonly accepted: readonly number[];
  readonly rejected: readonly IngestRejection[];
  readonly duplicate: readonly number[];
  readonly event_results: readonly IngestEventResult[];
}

interface ValidatedEvent {
  readonly index: number;
  readonly input: IngestEventInput;
  readonly event: CanonicalWorkEvent;
}

/** The first issue's message; the schema-violation token keeps a human hint. */
function firstIssueMessage(error: ZodError): string {
  return error.issues[0]?.message ?? 'schema violation';
}

/** The first issue's path as a batch-relative JSON pointer. */
function pointerFor(error: ZodError, index: number): string {
  const path = error.issues[0]?.path ?? [];
  const suffix = path.length === 0 ? '' : `/${path.join('/')}`;
  return `/events/${String(index)}/event${suffix}`;
}

/**
 * Runs the batch. Validation is per event; append is per batch. The project is
 * the first validated event's project — every other event must agree with it,
 * so a batch never touches more than one project.
 */
export async function ingestBatch(
  deps: IngestBatchDeps,
  request: IngestBatchRequest,
): Promise<IngestBatchResponse> {
  const rejections: IngestRejection[] = [];
  const duplicates: number[] = [];
  const seenInBatch = new Set<string>();
  const validated: ValidatedEvent[] = [];

  request.events.forEach((input, index) => {
    if (seenInBatch.has(input.event_id)) {
      // The same id twice in one batch is the same event twice: the ledger
      // would refuse the append, so the second copy is a duplicate here.
      duplicates.push(index);
      return;
    }
    seenInBatch.add(input.event_id);

    let event: CanonicalWorkEvent;
    try {
      event = parseCanonicalWorkEvent(input.event);
    } catch (error) {
      if (error instanceof UnsupportedWorkEventVersionError) {
        rejections.push({
          index,
          token: ingestRejectionTokens.schema_version_unsupported,
          detail: error.message,
          path: `/events/${String(index)}/event/schema_version`,
        });
      } else if (error instanceof ZodErrorValue) {
        rejections.push({
          index,
          token: ingestRejectionTokens.schema_violation,
          detail: firstIssueMessage(error),
          path: pointerFor(error, index),
        });
      } else {
        throw error;
      }
      return;
    }

    if (deps.verifyPayloadHash && input.payload_hash !== undefined) {
      const computed = createHash('sha256').update(canonicalJson(event)).digest('hex');
      if (computed !== input.payload_hash.value) {
        rejections.push({
          index,
          token: ingestRejectionTokens.payload_hash_mismatch,
          detail: 'the claimed payload hash does not match the received payload',
          path: `/events/${String(index)}/payload_hash`,
        });
        return;
      }
    }

    validated.push({ index, input, event });
  });

  const [first] = validated;
  const projectId = first === undefined ? null : first.event.project_id;
  if (projectId === null) {
    // No event survived validation: nothing to dedup, nothing to append.
    return {
      projectId: null,
      accepted: [],
      rejected: rejections,
      duplicate: duplicates,
      event_results: resultsFor(request.events.length, [], rejections, duplicates),
    };
  }

  // Every event must belong to the batch's project; a mixed batch is refused
  // per event, never silently split.
  const toAppend: ValidatedEvent[] = [];
  for (const entry of validated) {
    if (entry.event.project_id !== projectId) {
      rejections.push({
        index: entry.index,
        token: ingestRejectionTokens.authorization_denied,
        detail: 'event project does not match the batch project',
        path: `/events/${String(entry.index)}/event/project_id`,
      });
    } else {
      toAppend.push(entry);
    }
  }

  const identities = await deps.eventStore.existingEventIdentities(
    projectId,
    toAppend.map((entry) => entry.input.event_id),
  );
  const storedDevice = new Map(
    identities.map((identity) => [identity.event_id, identity.device_id] as const),
  );
  const appended: ValidatedEvent[] = [];
  for (const entry of toAppend) {
    const known = storedDevice.get(entry.input.event_id);
    if (known === request.deviceId) {
      duplicates.push(entry.index);
      continue;
    }
    if (known !== undefined) {
      rejections.push({
        index: entry.index,
        token: ingestRejectionTokens.ledger_conflict,
        detail: 'event id already belongs to another device',
        path: `/events/${String(entry.index)}/event_id`,
      });
      continue;
    }
    appended.push(entry);
  }

  if (appended.length > 0) {
    const head = await deps.eventStore.headSeq(projectId);
    const snapshot = await deps.eventStore.loadSnapshot(projectId);
    const stateVersion = snapshot === null ? 0 : snapshot.state_version;
    const envelopes = appended.map((entry, offset) =>
      toEnvelope(entry, request, head + offset + 1, stateVersion, deps.now()),
    );
    // One append carries the whole batch: the ledger's optimistic-concurrency
    // guard makes it all-or-nothing, and a conflict is thrown, not swallowed
    // into a per-event token — it is transient, and the daemon's retry budget
    // owns it (standard 08).
    await deps.eventStore.append(projectId, envelopes, head);
  }

  return {
    projectId,
    accepted: appended.map((entry) => entry.index),
    rejected: rejections,
    duplicate: duplicates,
    event_results: resultsFor(request.events.length, appended, rejections, duplicates),
  };
}

/**
 * Maps a validated event to its ledger envelope, following the capture flow's
 * convention: the aggregate is anchored on the project, `state_version`
 * repeats the latest snapshot's version because every ingest event is an
 * observation, and the dedup pair is the idempotency claim.
 */
function toEnvelope(
  entry: ValidatedEvent,
  request: IngestBatchRequest,
  seq: number,
  stateVersion: number,
  recordedAt: string,
): EventEnvelope {
  return eventEnvelopeSchema.parse({
    event_id: entry.input.event_id,
    project_id: entry.event.project_id,
    seq,
    aggregate_type: 'project',
    aggregate_id: entry.event.project_id,
    aggregate_revision: seq,
    event_type: entry.event.event_type,
    event_schema_version: entry.event.schema_version,
    occurred_at: entry.event.occurred_at,
    recorded_at: recordedAt,
    actor_participant_id: null,
    causation_id: entry.input.causation_id ?? null,
    correlation_id: null,
    idempotency_key: `${request.deviceId}:${entry.input.event_id}`,
    payload: entry.event.payload,
    metadata: {
      device_id: request.deviceId,
      source_runtime: entry.event.source_runtime,
      source_session_id: entry.event.source_session_id,
      extractor_version: entry.event.extractor_version,
    },
    privacy_class: privacyClassFor(entry.event.event_type),
    state_version: stateVersion,
  });
}

/** One outcome per batch index, in batch order. */
function resultsFor(
  count: number,
  appended: readonly { index: number }[],
  rejections: readonly IngestRejection[],
  duplicates: readonly number[],
): IngestEventResult[] {
  const outcomes = new Map<number, IngestEventResult>();
  for (const entry of appended) {
    outcomes.set(entry.index, { index: entry.index, outcome: 'accepted' });
  }
  for (const index of duplicates) {
    outcomes.set(index, { index, outcome: 'duplicate' });
  }
  for (const rejection of rejections) {
    outcomes.set(rejection.index, { index: rejection.index, outcome: 'rejected', rejection });
  }
  const results: IngestEventResult[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = outcomes.get(index);
    if (result !== undefined) results.push(result);
  }
  return results;
}
