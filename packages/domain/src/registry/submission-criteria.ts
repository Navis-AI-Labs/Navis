/**
 * Submission criteria contract — the deterministic gate between an action
 * submission and its execution. Criteria functions evaluate a frozen action
 * context and return a verdict; they never mutate state, read the clock, or
 * perform I/O, so the same context always yields the same result. The
 * actor facts live on the context as a read-only snapshot (registration and
 * participant type) — authorization is policy applied to those facts and is
 * never derived from the descriptive role field. The registry is
 * literal-keyed and closed: a criteria reference resolves only to a defined
 * criteria, and an unknown reference fails explicitly.
 */

import type { ParticipantType } from '../schema/participant.js';

export interface ActorSnapshot {
  readonly registered: boolean;
  readonly type: ParticipantType;
}

export interface ActionContext {
  readonly actor: string;
  readonly action: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly state_version: number;
  readonly equip_state_version?: number;
  readonly actor_snapshot: ActorSnapshot;
}

export interface SubmissionResult {
  readonly passed: boolean;
  readonly reason?: string;
}

export type CriteriaFunction = (context: ActionContext) => SubmissionResult;

/**
 * The operation families the kernel gates to human participants today
 * (acceptance verdicts ride the accept_asset command — rejection and
 * conditional acceptance are results of it, not separate commands).
 * Mirrors the human-only guard flag at the kernel's command entries;
 * the reconciliation test pins the two lists together.
 */
const humanOnlyActions: ReadonlySet<string> = new Set([
  'update_boundary',
  'create_work',
  'cancel_work',
  'redirect_work',
  'accept_asset',
]);

/**
 * Baseline permission check: the actor must be a registered participant,
 * and a human-only action demands a human participant — the same two
 * authorization facts the kernel's command guards enforce.
 */
export function checkActorPermission(context: ActionContext): SubmissionResult {
  if (!context.actor_snapshot.registered) {
    return { passed: false, reason: 'unknown-actor' };
  }
  if (humanOnlyActions.has(context.action) && context.actor_snapshot.type !== 'human') {
    return { passed: false, reason: 'actor-kind-not-authorized' };
  }
  return { passed: true };
}

const criteriaRegistry: Readonly<Record<string, CriteriaFunction>> = Object.freeze({
  check_actor_permission: checkActorPermission,
});

export function resolveCriteria(name: string): CriteriaFunction {
  const criteria = criteriaRegistry[name];
  if (criteria === undefined) {
    throw new Error(`criteria not defined: ${name}`);
  }
  return criteria;
}
