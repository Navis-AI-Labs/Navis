import type { InterventionMode } from '../schema/workrun.js';

/**
 * Intervention concurrency manager — the multi-read-one-write session
 * ledger rules for a running WorkRun, as pure functions over the run's
 * session list. The kernel command layer and the replay path both consume
 * this module, so the live command gates and the reconstructed projection
 * can never disagree.
 *
 * Rules owned here:
 * - observe and assist sessions may run in parallel without limit;
 * - takeover is exclusive: at most one active takeover session may exist,
 *   and a takeover is permitted only for a participant that already holds
 *   an active observe or assist session on the run (no presence, no takeover);
 * - the run's derived intervention mode is the strongest active mode
 *   (takeover > assist > observe), undefined when no session is active;
 * - closing a session is permitted to its owner or to any human participant;
 * - consent: assist and takeover sessions open as `pending` and record their
 *   terminal value (`granted` | `denied`) when closed; observe needs none.
 */

/** One intervention session on a run — the session-ledger row shape. */
export interface RunSessionRow {
  readonly session_id: string;
  readonly participant_id: string;
  readonly mode: InterventionMode;
  readonly started_at: string;
  readonly ended_at?: string;
  readonly consent_status?: 'granted' | 'denied' | 'pending';
}

/** Sessions that have not ended yet. */
export function activeSessions(sessions: readonly RunSessionRow[]): readonly RunSessionRow[] {
  return sessions.filter((s) => s.ended_at === undefined);
}

// Strongest-first mode ladder; the derived run mode is the first entry any active session holds.
const MODE_STRENGTH: readonly InterventionMode[] = ['takeover', 'assist', 'observe'];

/** The strongest active mode, or undefined when no session is active. */
export function strongestActiveMode(
  sessions: readonly RunSessionRow[],
): InterventionMode | undefined {
  const active = activeSessions(sessions);
  return MODE_STRENGTH.find((m) => active.some((s) => s.mode === m));
}

export type TakeoverOpeningResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'takeover-held' | 'presence-required' };

/**
 * Takeover exclusivity plus the presence prerequisite. The exclusivity
 * check runs first, so a participant holding the active takeover cannot
 * open a second one either.
 */
export function checkTakeoverOpening(
  sessions: readonly RunSessionRow[],
  participantId: string,
): TakeoverOpeningResult {
  const active = activeSessions(sessions);
  if (active.some((s) => s.mode === 'takeover')) {
    return { ok: false, reason: 'takeover-held' };
  }
  if (!active.some((s) => s.participant_id === participantId)) {
    return { ok: false, reason: 'presence-required' };
  }
  return { ok: true };
}

export type CloseAuthorityResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'close-not-permitted' };

/**
 * Close authority: the session's owner always may (a takeover holder
 * releasing their own session is just the owner closing); a third party
 * may close only as a human participant.
 */
export function checkCloseAuthority(
  session: RunSessionRow,
  actorId: string,
  actorIsHuman: boolean,
): CloseAuthorityResult {
  if (session.participant_id === actorId) return { ok: true };
  if (actorIsHuman) return { ok: true };
  return { ok: false, reason: 'close-not-permitted' };
}

/** Consent a session opens with: `pending` for assist/takeover, none for observe. */
export function initialConsent(mode: InterventionMode): 'pending' | undefined {
  return mode === 'observe' ? undefined : 'pending';
}

export type ConsentCloseResult =
  | { readonly ok: true; readonly consent?: 'granted' | 'denied' }
  | { readonly ok: false; readonly reason: 'consent-required' | 'consent-not-applicable' };

/**
 * Terminal consent validation at close time: assist and takeover sessions
 * must record their terminal value; observe sessions carry no consent.
 */
export function checkTerminalConsent(
  mode: InterventionMode,
  consent: 'granted' | 'denied' | undefined,
): ConsentCloseResult {
  if (mode === 'observe') {
    return consent === undefined ? { ok: true } : { ok: false, reason: 'consent-not-applicable' };
  }
  if (consent !== 'granted' && consent !== 'denied') {
    return { ok: false, reason: 'consent-required' };
  }
  return { ok: true, consent };
}
