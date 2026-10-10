export {
  canonicalEquals,
  canonicalJson,
  deepFreeze,
  immutableCopy,
  parseCanonicalJson,
} from './canonical.js';
export { advanceClock, compareClocks, mergeClocks } from './vector-clock.js';
export type { ClockSnapshot, ClockVerdict } from './vector-clock.js';
export { EventHistory } from './event-history.js';
export { scopeVisibleForProject } from './scope-visibility.js';
export {
  stateEventSchema,
  STATE_EVENT_SCHEMA_VERSION,
  KERNEL_EVENT_TYPES,
  type KernelEventType,
  type ObservationValidator,
  type StateEvent,
} from './events.js';
export { EQUIP_SIZE_BUDGET, ProjectStateKernel } from './project-state-kernel.js';
export { COMPETITIVE_GRACE_PERIOD_DAYS } from '../schema/asset.js';
export type { KernelProjection } from './projection.js';
export {
  activeSessions,
  checkCloseAuthority,
  checkTakeoverOpening,
  checkTerminalConsent,
  initialConsent,
  strongestActiveMode,
} from './intervention.js';
export type { RunSessionRow } from './projection.js';
export {
  acceptanceAnchor,
  computeStrength,
  shapeSuggestion,
  NEUTRAL_BASELINE,
  OBSERVATION_FLOOR_WORKS,
  STRENGTH_SCORE_MAX,
  STRENGTH_SCORE_MIN,
  SUGGESTION_THRESHOLD,
} from './strength.js';
export type {
  RetirementSuggestion,
  StrengthInput,
  StrengthResult,
  StrengthSignals,
} from './strength.js';
export {
  evaluateCaptureDue,
  extractCaptureAnchor,
  extractProjectionState,
  serializeProjectionState,
  serializeProjectionStateRecord,
  validateSnapshotUsability,
} from './snapshot.js';
export type {
  CaptureAnchor,
  CaptureDueEvaluation,
  CaptureDueInput,
  CapturePolicy,
  CaptureTrigger,
  SnapshotUsabilityResult,
} from './snapshot.js';
