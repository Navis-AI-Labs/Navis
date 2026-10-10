/** Device-local mapping from a repository declaration to verified project membership. Paths and fingerprints remain local. */

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
  /** Optional instance URL from the repository declaration. */
  readonly remote: string | null;
  /** Local policy used to determine upload eligibility. */
  readonly privacy_class: 'local-only' | 'metadata' | 'work';
  /** ISO 8601 timestamp the binding was verified. */
  readonly bound_at: string;
  /** Server-side state version the daemon last loaded (starts null). */
  readonly last_loaded_state_version: number | null;
  /** Reserved for nested-toml support; always null today. */
  readonly parent_binding_id: null;
}

export interface BindingTablePort {
  put(record: BindingRecord): Promise<void>;
  get(tomlPath: string, deviceId: string): Promise<BindingRecord | null>;
  /** Stored bindings for a device, newest binding time first. */
  listForDevice(deviceId: string): Promise<readonly BindingRecord[]>;
}
