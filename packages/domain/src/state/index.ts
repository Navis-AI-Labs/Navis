export { canonicalEquals, canonicalJson, deepFreeze, parseCanonicalJson } from './canonical.js';
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
export {
  activeSessions,
  checkCloseAuthority,
  checkTakeoverOpening,
  checkTerminalConsent,
  initialConsent,
  strongestActiveMode,
} from './intervention.js';
export type { RunSessionRow } from './intervention.js';
