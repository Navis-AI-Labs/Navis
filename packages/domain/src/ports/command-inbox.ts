import { createHash } from 'node:crypto';

import { canonicalJson } from '../state/canonical.js';

/**
 * Command idempotency intake — one engine-neutral port. A submission is
 * identity (project, idempotency key) plus a canonical payload fingerprint;
 * begin either installs a fresh claim, replays the stored outcome of an
 * identical finished submission, or reports an in-flight claim. A key whose
 * stored hash differs from the incoming one is a collision and refuses
 * loudly — same key never silently replays a different command (D1/D2 of
 * the owning change).
 */

/** Outcome terminal record: what a finished submission produced, stored as canonical JSON. */
export type CommandOutcome =
  | { readonly status: 'applied'; readonly result: string }
  | { readonly status: 'failed'; readonly result: string };

/** The begin verdict. */
export type BeginResult =
  | { readonly status: 'fresh' }
  | { readonly status: 'replay'; readonly outcome: CommandOutcome }
  | { readonly status: 'processing' };

export interface CommandInbox {
  /**
   * Claims or resolves a submission. `fresh` exactly once per (project,
   * key); equal-key resubmissions with an identical payload fingerprint
   * return `replay` (terminal) or `processing` (in-flight); a hash
   * mismatch on an existing key throws a collision error.
   */
  begin(
    projectId: string,
    key: string,
    commandType: string,
    payloadHash: string,
  ): Promise<BeginResult>;

  /**
   * Completes a fresh claim with its terminal outcome; completing an
   * unknown key throws.
   */
  complete(projectId: string, key: string, outcome: CommandOutcome): Promise<void>;
}

/** Stable error factories for the claim vocabulary (same-law as kernel errors). */
export const inboxErrors = {
  collision: () => new Error('idempotency-key-collides-with-different-payload'),
  unknownKey: () => new Error('idempotency-key-has-no-claim'),
};

/**
 * Canonical submission fingerprint: `sha256:`-prefixed SHA-256 hex over the
 * canonical JSON of the command. Canonicalization makes field order
 * irrelevant; the streamed tag lets a future algorithm upgrade coexist with
 * stored rows without a silent collision.
 */
export function hashCommandPayload(command: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(command), 'utf8').digest('hex');
}
