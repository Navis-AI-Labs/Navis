-- Daemon local binding table (spec §5: local-only, never uploaded).
-- One row per (toml_path, device_id); project_id/project remote/participant_id
-- are verified server-side at bind time and the verification result is what
-- lands here — the toml itself is never trusted.
CREATE TABLE device_bindings (
  binding_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  toml_path TEXT NOT NULL,
  toml_fingerprint TEXT NOT NULL,
  device_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  remote TEXT,
  privacy_class TEXT NOT NULL DEFAULT 'metadata'
    CHECK (privacy_class IN ('local-only', 'metadata', 'work')),
  bound_at TEXT NOT NULL,
  last_loaded_state_version INTEGER,
  parent_binding_id TEXT,
  UNIQUE (toml_path, device_id)
);

CREATE INDEX idx_device_bindings_device ON device_bindings (device_id);
CREATE INDEX idx_device_bindings_toml ON device_bindings (toml_path);

-- schema_migrations is created by the loader itself, before any migration runs.
