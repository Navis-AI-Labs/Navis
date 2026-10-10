/** Captured events remain local until eligible for upload. Acknowledgment removes records; failed sends are released for retry. */

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
  /** Recorded send failures or recovery releases. */
  readonly retry_count: number;
  /* when the next retry becomes due; null means try-now */
  readonly retry_after: string | null;
  /** Optional payload fingerprint. */
  readonly payload_hash: string | null;
  /** Serialized captured event. */
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
  /** Stores captured events; a local-only policy routes them directly to local_only. */
  capture(input: OutboxCaptureInput): Promise<OutboxEvent>;
  /** Reads one record by id after capture; absent → null. */
  get(eventId: string): Promise<OutboxEvent | null>;
  /** Moves a captured or sending record to pending. Sequence allocation and the state change commit together; other states are rejected. */
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
