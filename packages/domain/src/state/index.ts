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
export { stateEventSchema, type StateEvent } from './events.js';
export {
  COMPETITIVE_GRACE_PERIOD_DAYS,
  EQUIP_SIZE_BUDGET,
  STATE_EVENT_SCHEMA_VERSION,
  KERNEL_EVENT_TYPES,
  ProjectStateKernel,
} from './project-state-kernel.js';
export type { KernelEventType } from './project-state-kernel.js';
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
