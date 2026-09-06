/**
 * Registry barrel — the read-only type registry and the submission
 * criteria contract. Both are closed by construction: literal-keyed,
 * frozen, no dynamic registration path.
 */

export { typeRegistry } from './type-registry.js';

export {
  type ActionContext,
  type ActorSnapshot,
  checkActorPermission,
  type CriteriaFunction,
  resolveCriteria,
  type SubmissionResult,
} from './submission-criteria.js';

export type { ParticipantType } from '../schema/participant.js';
