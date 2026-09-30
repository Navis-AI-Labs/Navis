-- Outbox: machine-local buffering before upload (spec §the Outbox).
-- States: captured → normalized → pending → sending → acked, plus terminal
-- local_only and quarantined. seq is allocated only at normalized→pending so
-- local-only leftovers never open a gap in the server-side sequence.
--
-- retry_count / retry_after belong to the upload loop (task 6.4): on send
-- failure the row returns to pending with a next-attempt timestamp; on ack
-- the row is deleted. Nothing survives a SIGKILL mid-send — the WAL journal
-- keeps the last consistent checkpoint.
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
