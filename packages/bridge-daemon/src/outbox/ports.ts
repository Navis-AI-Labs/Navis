/**
 * Outbox port (spec §the Outbox).
 *
 * The contract here is the state machine plus the persistence guarantees.
 * All consistency rules are structural: a `local_only` event never gets a
 * `seq`, the `pending→sending` transition is one atomic transaction per
 * batch, and the only way a row disappears is `acknowledgedByServer`.
 * `failureAcknowledgeOrigin` is kept for symmetry with test scaffolds; the
 * spec for the failure path is `releaseSending`, which surfaces the event
 * for retry instead of deleting it.
 */

export type OutboxState =
  'captured' | 'normalized' | 'pending' | 'sending' | 'acked' | 'local_only' | 'quarantined';

export interface OutboxEvent {
  readonly event_id: string;
  readonly device_id: string;
  readonly project_id: string;
  readonly state: OutboxState;
  /* null until normalized→pending; null forever for local_only */
  readonly seq: number | null;
  readonly causation_id: string | null;
  readonly event_type: string;
  readonly captured_at: string;
  readonly normalized_at: string | undefined;
  readonly sending_at: string | undefined;
  readonly acked_at: string | undefined;
  /* only set in local_only / quarantined */
  readonly keep_reason: string | null;
  /* how many times the upload loop has tried to send the row */
  readonly retry_count: number;
  /* when the next retry becomes due; null means try-now */
  readonly retry_after: string | null;
  /* ingest-side hash the server recorded at put (spec §batch ack ledger) */
  readonly payload_hash: string | null;
  /* the canonical envelope as ingested (never normalized out of it) */
  readonly event_json: string;
}

export interface OutboxCaptureInput {
  readonly event_id: string;
  readonly device_id: string;
  readonly project_id: string;
  readonly causation_id?: string;
  readonly event_type: string;
  readonly event_json: string;
  /** The binding's privacy rule captured alongside the event. */
  readonly privacy_class: 'local-only' | 'metadata' | 'work';
}

export interface OutboxPort {
  /** capture() is the "captured" state with the seq rule applied at first normalize. */
  capture(input: OutboxCaptureInput): Promise<OutboxEvent>;
  /** Reads one record by id after capture; absent → null. */
  get(eventId: string): Promise<OutboxEvent | null>;
  /**
   * promote the record: captured → normalized → pending, all within one
   * transaction so `seq` is allocated once and only once; already-terminal
   * records are left untouched.
   */
  promoteToPending(eventId: string, bindingId: string): Promise<OutboxEvent>;
  /**
   * claim «pending» rows that are due (`retry_after` elapsed or null),
   * bounded by `limit`; marks them sending so the next loop instance skips
   * them until they are released.
   */
  claimPending(deviceId: string, limit: number, nowIso: string): Promise<readonly OutboxEvent[]>;
  /** acknowledge a batch; rows with acknowledged ids are deleted. */
  acknowledge(eventIds: readonly string[]): Promise<void>;
  /**
   * mark a crash-recovered / send-failed event back as pending; the store
   * **increments retry_count** and stamps retry_after with the configured
   * exponential backoff, so the next claim returns it only when due.
   * Returns the retry_after value per id — caller's tick decides when to run again.
   */
  releaseSending(
    eventIds: readonly string[],
  ): Promise<readonly { eventId: string; retry_after: string | null }[]>;
  /**
   * Offload an event the binding said to keep local. Terminal state, `seq`
   * stays null, `keep_reason` carries the categorical explanation.
   */
  parkLocalOnly(eventId: string, reason: string): Promise<void>;
  /** mark the server-rejected row as quarantined — kept, not deleted. */
  quarantine(eventId: string, reason: string): Promise<void>;
}
