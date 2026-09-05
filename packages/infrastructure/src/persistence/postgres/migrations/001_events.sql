-- 001_events.sql — Navis R0 kernel persistence. Plain SQL, idempotent, tracked in schema_migrations.

-- ============ migrations bookkeeping ============
-- The runner (connection.ts) owns schema_migrations: it creates the table,
-- applies this file inside a transaction, and records the version + file
-- checksum. This file contains no self-registration.

-- ============ L1: append-only event ledger ============
-- The single authority. UPDATE/DELETE are rejected by trigger; optimistic concurrency rides UNIQUE(project_id, seq).

CREATE TABLE IF NOT EXISTS project_events (
  event_id             uuid PRIMARY KEY,
  project_id           uuid NOT NULL,
  seq                  bigint NOT NULL CHECK (seq >= 1),
  aggregate_type       text NOT NULL CHECK (length(aggregate_type) <= 64),
  aggregate_id         uuid NOT NULL,
  aggregate_revision   bigint NOT NULL CHECK (aggregate_revision >= 1),
  event_type           text NOT NULL CHECK (length(event_type) <= 128),
  event_schema_version integer NOT NULL CHECK (event_schema_version >= 1),
  occurred_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL,
  actor_participant_id uuid,
  causation_id         text CHECK (length(causation_id) <= 512),
  correlation_id       text CHECK (length(correlation_id) <= 512),
  idempotency_key      text CHECK (length(idempotency_key) <= 512),
  payload              jsonb NOT NULL,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  privacy_class        text NOT NULL DEFAULT 'evidence' CHECK (privacy_class IN ('evidence','work','audit')),
  state_version        bigint NOT NULL CHECK (state_version >= 0),
  UNIQUE (project_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_project_events_agg
  ON project_events (aggregate_type, aggregate_id, aggregate_revision);
CREATE INDEX IF NOT EXISTS idx_project_events_state_version
  ON project_events (project_id, state_version);

-- Append-only enforcement: reject UPDATE and DELETE on ledger rows.
CREATE OR REPLACE FUNCTION project_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'project_events is append-only: % blocked', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_events_append_only_guard ON project_events;
CREATE TRIGGER project_events_append_only_guard
  BEFORE UPDATE OR DELETE ON project_events
  FOR EACH ROW EXECUTE FUNCTION project_events_append_only();

-- ============ L2: append-only fact rows ============
-- Judgments, delivery attempts, and side-effect ledger entries never mutate; retries are new rows.

CREATE TABLE IF NOT EXISTS acceptances (
  id                uuid PRIMARY KEY,
  project_id        uuid NOT NULL, -- ownership anchor: denormalized from the accepted target's project for gate queries
  target_ref        uuid NOT NULL,
  target_type       text NOT NULL DEFAULT 'Asset' CHECK (target_type = 'Asset'), -- single value
  result            text NOT NULL CHECK (result IN ('accepted', 'rejected', 'conditional')),
  actor             uuid NOT NULL,
  rationale         text,
  criteria_snapshot jsonb NOT NULL, -- the criteria as of judgment time
  evidence_refs     uuid[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL,
  deleted_at        timestamptz,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  updated_at        timestamptz,
  updated_by        uuid,
  CHECK (rationale IS NOT NULL OR result NOT IN ('rejected', 'conditional')) -- rationale rule
);

CREATE INDEX IF NOT EXISTS idx_acceptances_target ON acceptances (project_id, target_ref);

CREATE TABLE IF NOT EXISTS deliveries (
  id                  uuid PRIMARY KEY,
  project_id          uuid NOT NULL, -- ownership anchor: denormalized from the delivering asset's project for gate queries
  asset_id            uuid NOT NULL,
  target_ref          text NOT NULL,
  target_type         text NOT NULL CHECK (target_type IN ('staging','production','customer_confirmation','business_process','external_system')),
  dispatched_at       timestamptz NOT NULL, -- the send-out fact
  version             text NOT NULL CHECK (version ~ '^[0-9a-f]{64}$'), -- content.sha256 anchor
  attempt_no          integer NOT NULL CHECK (attempt_no >= 1), -- first-attempt fact on the delivery row
  confirmation_status text NOT NULL DEFAULT 'delivered' CHECK (confirmation_status IN ('delivered','confirmed','rejected','pending')),
  confirmed_by        uuid,
  confirmed_at        timestamptz,
  feedback            text,
  created_at          timestamptz NOT NULL,
  deleted_at          timestamptz,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  updated_at          timestamptz,
  updated_by          uuid,
  CHECK (confirmation_status NOT IN ('confirmed','rejected') OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);

-- Per-delivery attempt lineage: retries are new fact rows here; attempt_no
-- is unique per delivery. The open-attempt gate stays on deliveries above.
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id            uuid PRIMARY KEY,
  project_id    uuid NOT NULL, -- ownership anchor: denormalized from the parent delivery for gate queries
  delivery_id   uuid NOT NULL,
  attempt_no    integer NOT NULL CHECK (attempt_no >= 1),
  dispatched_at timestamptz NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('delivered','pending','rejected')),
  outcome_reason text,
  created_at    timestamptz NOT NULL,
  deleted_at    timestamptz,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  updated_at    timestamptz,
  updated_by    uuid,
  UNIQUE (delivery_id, attempt_no)
);

-- One open attempt per (asset, target): retries are new rows.
-- Tombstoned attempts release their slot: retirement ends the attempt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deliveries_open_attempt
  ON deliveries (project_id, asset_id, target_type, target_ref)
  WHERE confirmation_status IN ('delivered', 'pending') AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS effect_ledger (
  effect_id     uuid PRIMARY KEY,
  project_id    uuid NOT NULL,
  work_run_id   uuid,
  intent        jsonb NOT NULL,
  status        text NOT NULL CHECK (status IN ('intent','sent','confirmed','failed','unknown')),
  provider_ref  text,
  provider_result jsonb,
  causation_id  text,
  correlation_id text,
  recorded_at   timestamptz NOT NULL,
  closed_at     timestamptz,
  -- replay-writable read caches, same convention as the other mutable projection tables
  updated_at    timestamptz,
  updated_by    uuid
);

-- Delivery-gate authority half: unclosed unknown effects block delivery.
CREATE INDEX IF NOT EXISTS idx_effect_ledger_unknown
  ON effect_ledger (project_id) WHERE status = 'unknown';

-- ============ L3: synchronous projections (replay-maintained) ============
-- updated_at/updated_by are replay-writable read caches; these tables are rebuildable from L1.

CREATE TABLE IF NOT EXISTS projects (
  id                   uuid PRIMARY KEY,
  title                text NOT NULL,
  purpose              text,
  boundary             text,
  status               text NOT NULL CHECK (status IN ('active','paused','completed','archived')),
  current_state_version bigint NOT NULL DEFAULT 0 CHECK (current_state_version >= 0),
  acceptance_criteria  jsonb,
  -- authoritative causal clock read cache, participant id to events seen,
  -- rebuildable in full from event authorship, same convention as the
  -- other L3 projection caches
  causal_clock         jsonb,
  last_event_seq       bigint NOT NULL DEFAULT 0, -- replay cursor; rebuildable
  created_at           timestamptz NOT NULL,
  deleted_at           timestamptz,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  updated_at           timestamptz,
  updated_by           uuid
);

CREATE TABLE IF NOT EXISTS participants (
  id          uuid PRIMARY KEY,
  project_id  uuid NOT NULL,
  type        text NOT NULL CHECK (type IN ('human','agent')),
  display_name text,
  role        text, -- descriptive only; authorization never derives from it
  created_at  timestamptz NOT NULL,
  deleted_at  timestamptz,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  updated_at  timestamptz,
  updated_by  uuid
);

CREATE TABLE IF NOT EXISTS works (
  id          uuid PRIMARY KEY,
  project_id  uuid NOT NULL,
  title       text NOT NULL,
  status      text NOT NULL CHECK (status IN ('planned','in_progress','blocked','completed','cancelled')),
  direction   text,
  acceptance_criteria jsonb,
  created_at  timestamptz NOT NULL,
  deleted_at  timestamptz,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  updated_at  timestamptz,
  updated_by  uuid
);

-- L5 relation rows for Work.depends_on (array cannot carry FK or cycle checks).
CREATE TABLE IF NOT EXISTS work_dependencies (
  work_id            uuid NOT NULL,
  depends_on_work_id uuid NOT NULL,
  PRIMARY KEY (work_id, depends_on_work_id)
);

CREATE TABLE IF NOT EXISTS assets (
  id          uuid PRIMARY KEY,
  project_id  uuid, -- required unless scope=organization
  kind        text NOT NULL CHECK (kind IN ('context','knowledge','experience','skill','artifact','evidence','template')),
  scope       text NOT NULL CHECK (scope IN ('participant','session','task','project','organization')),
  provenance  text,
  lifecycle   text NOT NULL CHECK (lifecycle IN ('candidate','active','superseded','competitive_superseded','deprecated','archived','rejected')),
  content     jsonb,
  valid_from  timestamptz,
  valid_to    timestamptz,
  created_at  timestamptz NOT NULL,
  deleted_at  timestamptz,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  -- ownership anchor mirrors the schema-layer refine: every asset names its
  -- project unless it sediments at organization scope.
  CHECK (scope = 'organization' OR project_id IS NOT NULL),
  updated_at  timestamptz,
  updated_by  uuid
);

-- Ownership anchor at the storage layer.
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_project_scope_ownership;
ALTER TABLE assets ADD CONSTRAINT assets_project_scope_ownership
  CHECK (scope = 'organization' OR project_id IS NOT NULL);

CREATE TABLE IF NOT EXISTS holds (
  id                   uuid PRIMARY KEY,
  project_id           uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('bug','tech_debt','deferred_decision','unvalidated_assumption','known_risk','skipped_edge_case')),
  severity             text NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  status               text NOT NULL CHECK (status IN ('registered','active','resolved','accepted','dormant','invalidated')),
  fowler_quadrant      text CHECK (fowler_quadrant IN ('prudent_deliberate','prudent_inadvertent','reckless_deliberate','reckless_inadvertent')),
  blocks_delivery      boolean NOT NULL DEFAULT false,
  statement            text NOT NULL, -- problem body
  registered_during_work uuid,
  registered_by        uuid NOT NULL,
  applicability        text, -- in which phase/conditions the hold still applies
  created_at           timestamptz NOT NULL,
  deleted_at           timestamptz,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  updated_at           timestamptz,
  updated_by           uuid
);

-- Cross-field rule at the storage layer: fowler_quadrant only for tech_debt.
ALTER TABLE holds DROP CONSTRAINT IF EXISTS holds_fowler_tech_debt_only;
ALTER TABLE holds ADD CONSTRAINT holds_fowler_tech_debt_only
  CHECK (fowler_quadrant IS NULL OR kind = 'tech_debt');

-- Delivery-gate authority half #1: active blocking holds.
-- A tombstoned hold is retired and never gates delivery.
CREATE INDEX IF NOT EXISTS idx_holds_gate
  ON holds (project_id) WHERE status = 'active' AND blocks_delivery AND deleted_at IS NULL;

-- The third time plane: what the project intends next. The CHECK pair makes
-- resolution all-or-nothing and always reason-carrying.
CREATE TABLE IF NOT EXISTS intended_directions (
  id                uuid PRIMARY KEY,
  project_id        uuid NOT NULL,
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
  detail            text,
  status            text NOT NULL CHECK (status IN ('proposed','confirmed','discarded')),
  proposed_by       uuid NOT NULL,
  proposed_at       timestamptz NOT NULL,
  resolved_by       uuid,
  resolved_at       timestamptz,
  resolution_reason text CHECK (resolution_reason IS NULL OR length(resolution_reason) BETWEEN 1 AND 4096),
  created_at        timestamptz NOT NULL,
  -- replay-writable read caches, same convention as the other mutable projection tables
  updated_at        timestamptz,
  updated_by        uuid,
  deleted_at        timestamptz,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CHECK ((resolved_by IS NULL) = (resolved_at IS NULL)),
  CHECK ((status = 'proposed') OR (resolved_by IS NOT NULL AND resolution_reason IS NOT NULL))
);

-- Run execution rows: run_revision is the per-run optimistic-concurrency
-- counter (distinct from state_version); the release flag arms the
-- fresh-equip resumption gate.
CREATE TABLE IF NOT EXISTS work_runs (
  id                  uuid PRIMARY KEY,
  work_id             uuid NOT NULL,
  parent_run_id       uuid,
  status              text NOT NULL CHECK (status IN ('ready','running','waiting_input','waiting_approval','paused','cancelling','cancelled','failed','completed')),
  run_revision        bigint NOT NULL DEFAULT 0 CHECK (run_revision >= 0),
  re_equip_required   boolean NOT NULL DEFAULT false,
  intervention_mode   text CHECK (intervention_mode IN ('observe','assist','takeover')),
  checkpoint_id       uuid,
  input_state_version bigint,
  attempt             integer,
  execution_refs      jsonb,
  created_at          timestamptz NOT NULL,
  deleted_at          timestamptz,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  updated_at          timestamptz,
  updated_by          uuid
);

-- Pause checkpoints: a resume anchors the run at a recorded state version.
CREATE TABLE IF NOT EXISTS checkpoints (
  id            uuid PRIMARY KEY,
  work_id       uuid NOT NULL,
  run_id        uuid, -- set when the checkpoint anchors a work run (pause/resume)
  reason        text,
  captured_at   timestamptz NOT NULL, -- logical time the checkpoint was captured
  state_version bigint NOT NULL CHECK (state_version >= 0),
  position      jsonb,
  resume_ref    jsonb
);

CREATE TABLE IF NOT EXISTS project_snapshots (
  project_id     uuid NOT NULL,
  state_version  bigint NOT NULL,
  schema_version integer NOT NULL,
  state          jsonb NOT NULL,
  created_at     timestamptz NOT NULL,
  PRIMARY KEY (project_id, state_version)
);

-- ============ L4: read models / outbox ============

CREATE TABLE IF NOT EXISTS event_outbox (
  project_id  uuid NOT NULL,
  event_id    uuid NOT NULL PRIMARY KEY,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  retry_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  created_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_outbox_pending
  ON event_outbox (created_at) WHERE status = 'pending';

-- ============ L5: relation tables ============

CREATE TABLE IF NOT EXISTS hold_source_events (
  hold_id  uuid NOT NULL,
  event_id uuid NOT NULL,
  PRIMARY KEY (hold_id, event_id)
);

CREATE TABLE IF NOT EXISTS hold_assets (
  hold_id  uuid NOT NULL,
  asset_id uuid NOT NULL,
  PRIMARY KEY (hold_id, asset_id)
);

CREATE TABLE IF NOT EXISTS workrun_effect_refs (
  work_run_id uuid NOT NULL,
  effect_id   uuid NOT NULL,
  PRIMARY KEY (work_run_id, effect_id)
);

CREATE TABLE IF NOT EXISTS workrun_evidence_refs (
  work_run_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  PRIMARY KEY (work_run_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS workrun_candidate_refs (
  work_run_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  PRIMARY KEY (work_run_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS intervention_sessions (
  id             uuid PRIMARY KEY,
  work_run_id    uuid NOT NULL,
  participant_id uuid NOT NULL,
  mode           text NOT NULL CHECK (mode IN ('observe','assist','takeover')),
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  consent_status text CHECK (consent_status IN ('granted','denied','pending'))
);

-- ============ command idempotency + retention marks ============

CREATE TABLE IF NOT EXISTS command_inbox (
  project_id     uuid NOT NULL,
  idempotency_key text NOT NULL,
  command_type   text NOT NULL,
  payload_hash   text NOT NULL,
  status         text NOT NULL DEFAULT 'received' CHECK (status IN ('received','applied','failed')),
  result_ref     text,
  created_at     timestamptz NOT NULL,
  UNIQUE (project_id, idempotency_key) -- replay returns the first result
);

CREATE TABLE IF NOT EXISTS event_retention_marks (
  project_id      uuid NOT NULL,
  seq             bigint NOT NULL,
  retention_class text NOT NULL CHECK (retention_class IN ('permanent','archive_after_snapshot')),
  PRIMARY KEY (project_id, seq)
);

-- State-material / schema / acceptance-rejection / competitive events are permanent.
INSERT INTO event_retention_marks (project_id, seq, retention_class)
SELECT project_id, seq, 'permanent'
FROM project_events
WHERE event_type IN (
  'boundary.updated',
  'project.status_changed',
  'schema.registered',
  'acceptance.recorded',
  'competitive.selection.recorded'
)
ON CONFLICT (project_id, seq) DO NOTHING;
