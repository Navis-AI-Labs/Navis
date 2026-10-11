-- Durable local captures; only validated server receipts permit deletion.
CREATE TABLE outbox_events (
  event_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('captured', 'normalized', 'pending', 'sending', 'acked',
                     'local_only', 'quarantined')),
  seq INTEGER,
  causation_id TEXT,
  event_type TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  normalized_at TEXT,
  sending_at TEXT,
  acked_at TEXT,
  keep_reason TEXT,
  payload_hash TEXT,
  event_json TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_after TEXT,
  UNIQUE (device_id, seq)
);

-- pending rows claimed by the upload loop; seq order honors causation replay.
-- retry_after carries the send-failure gate, so claimAfter filter is index-friendly.
CREATE INDEX idx_outbox_events_pending
  ON outbox_events (device_id, retry_after, seq)
  WHERE state = 'pending';

-- Acknowledgment must not reset the sequence allocator.
CREATE TABLE outbox_sequences (device_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL);

-- Capture identities and causal heads outlive acknowledged Outbox rows.
CREATE TABLE capture_receipts (event_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, captured_at TEXT NOT NULL);
CREATE TABLE session_heads (session_key TEXT PRIMARY KEY, event_id TEXT NOT NULL);
