import { randomUUID } from 'node:crypto';

import type { KeychainPort } from '../keychain.js';
import type { DaemonPaths } from '../paths.js';
import type { BindingTablePort, BindingRecord } from './ports.js';
import { findTomlUp, parseTomlBytes, tomlFingerprint } from './toml.js';

/**
 * The binding use case: a toml is a declaration, the server is the trust
 * basis. This is the whole sequence the CLI's `navis bridge link` drives:
 *
 * 1. walk the working directory up to find `navis.toml` (nearest-first);
 * 2. fingerprint its bytes;
 * 3. parse the two-key allowlist;
 * 4. reuse a matching fingerprint as an already-bound record (spec: equal
 *    fingerprint → the binding is still valid — no server round-trip);
 * 5. fingerprint mismatch → tamper, out (deliberate abort — a changed toml
 *    needs an owner-level re-bind, not silent drift);
 * 6. otherwise, verify with the server that the project exists and the
 *    device's participant is a member (spec: "inaccessible toml does not
 *    bind");
 * 7. persist the binding row — local-only by construction.
 */

export interface VerifierPort {
  /**
   * Asks the server whether this device key may bind this project. The
   * answer carries the verified participant id.
   */
  verify(claim: {
    projectId: string;
    deviceKey: string;
  }): Promise<
    | { readonly ok: true; readonly participantId: string }
    | { readonly ok: false; readonly reason: string }
  >;
}

export type BindOutcome =
  | { readonly status: 'bound'; readonly binding: BindingRecord; readonly reused: boolean }
  | { readonly status: 'unbound-no-toml' }
  | { readonly status: 'unbound-toml-invalid'; readonly reason: string }
  | { readonly status: 'unbound-verify-failed'; readonly reason: string }
  | {
      readonly status: 'unbound-tampered';
      readonly reason: string;
      readonly binding: BindingRecord;
    };

export interface BindServiceDeps {
  readonly bindings: BindingTablePort;
  readonly verifier: VerifierPort;
  /** The OS keychain the device key lives in (purpose: read, never write). */
  readonly keychain: KeychainPort;
  /** Where the daemon's keychain entry resides for this user. */
  readonly keychainRef: Pick<DaemonPaths, 'keychainService' | 'keychainAccount'>;
  readonly now: () => string;
}

/** Binds a directory's toml to its declared project if verification passes. */
export async function bindFromToml(
  deps: BindServiceDeps,
  cwd: string,
  deviceId: string,
): Promise<BindOutcome> {
  const hit = findTomlUp(cwd);
  if (hit === null) return { status: 'unbound-no-toml' };

  const fingerprint = tomlFingerprint(hit.bytes);
  const parsed = parseTomlBytes(hit.bytes);
  if (!parsed.ok) return { status: 'unbound-toml-invalid', reason: parsed.reason };

  const existing = await deps.bindings.get(hit.tomlPath, deviceId);
  if (existing !== null) {
    if (existing.project_id !== parsed.declaration.projectId) {
      return {
        status: 'unbound-tampered',
        reason: 'toml_project_id_changed',
        binding: existing,
      };
    }
    if (existing.toml_fingerprint !== fingerprint) {
      return {
        status: 'unbound-tampered',
        reason: 'toml_content_mismatch',
        binding: existing,
      };
    }
    return { status: 'bound', binding: existing, reused: true };
  }

  // first contact: the server decides — the toml asserted, it did not trust
  const deviceKey = await deps.keychain.get({
    service: deps.keychainRef.keychainService,
    account: deps.keychainRef.keychainAccount,
  });
  if (deviceKey === null) {
    return { status: 'unbound-verify-failed', reason: 'device-credential-missing' };
  }
  const verified = await deps.verifier.verify({
    projectId: parsed.declaration.projectId,
    deviceKey,
  });
  if (!verified.ok) return { status: 'unbound-verify-failed', reason: verified.reason };

  const binding: BindingRecord = {
    binding_id: randomUUID(),
    project_id: parsed.declaration.projectId,
    toml_path: hit.tomlPath,
    toml_fingerprint: fingerprint,
    device_id: deviceId,
    participant_id: verified.participantId,
    remote: parsed.declaration.remote,
    privacy_class: 'metadata',
    bound_at: deps.now(),
    last_loaded_state_version: null,
    parent_binding_id: null,
  };
  await deps.bindings.put(binding);
  return { status: 'bound', binding, reused: false };
}
