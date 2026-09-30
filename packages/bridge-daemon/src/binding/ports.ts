/**
 * Local binding table (spec §5: binding is local and never uploaded).
 *
 * Exactly eleven columns, no more, no less — the table is a local address
 * book for "this directory → this project", owned by the daemon's SQLite
 * database and never transmitted. The id and foreign keys are the only
 * pieces the server ever knows about (they identify what the server itself
 * issued); local paths stay local.
 */

export interface BindingRecord {
  /** The mapping id (uuid), minted on bind and stable until rebind. */
  readonly binding_id: string;
  /** The project the daemon verified at bind; the server owns this truth. */
  readonly project_id: string;
  /** Absolute path of the `navis.toml` that declared the binding. */
  readonly toml_path: string;
  /** SHA-256 of the toml file bytes; the tamper tripwire. */
  readonly toml_fingerprint: string;
  /** The device that holds the credential for this binding. */
  readonly device_id: string;
  /** The participant verified at bind; the server owns this truth. */
  readonly participant_id: string;
  /** Optional remote URL override from the toml; otherwise the daemon default. */
  readonly remote: string | null;
  /** Owner-set privacy boundary; drives the Outbox's upload vs. keep-local choice. */
  readonly privacy_class: 'local-only' | 'metadata' | 'work';
  /** ISO 8601 timestamp the binding was verified. */
  readonly bound_at: string;
  /** Server-side state version the daemon last loaded (starts null). */
  readonly last_loaded_state_version: number | null;
  /** Reserved for nested-toml support; always null today (design δ3). */
  readonly parent_binding_id: null;
}

export interface BindingTablePort {
  put(record: BindingRecord): Promise<void>;
  get(tomlPath: string, deviceId: string): Promise<BindingRecord | null>;
  /** Every live binding for a device, refreshed order newest first. */
  listForDevice(deviceId: string): Promise<readonly BindingRecord[]>;
}
