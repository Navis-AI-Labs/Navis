/**
 * Model schemas share the governed base quartet — created_at,
 * deleted_at, updated_at, updated_by (Equip and Checkpoint are exempt as
 * derived/point-in-time records). Fields stay explicit in every model; this
 * comment is the single explanation point, enforced by the baseline guard test.
 */

export {
  acceptanceResultSchema,
  acceptanceSchema,
  acceptanceTargetTypeSchema,
  type Acceptance,
  type AcceptanceResult,
  type AcceptanceTargetType,
} from './acceptance.js';

export {
  assertTransition,
  assetContentSchema,
  assetContentStorageSchema,
  assetKindSchema,
  assetLifecycleSchema,
  assetScopeSchema,
  assetSchema,
  PURGE_AGE_THRESHOLD_DAYS,
  type Asset,
  type AssetContent,
  type AssetContentStorage,
  type AssetKind,
  type AssetLifecycle,
  type AssetScope,
  type PurgeGateInput,
  type TransitionResult,
} from './asset.js';

export { causalClockSnapshotSchema, type CausalClockSnapshot } from './causal-clock.js';

export { checkpointSchema, type Checkpoint } from './checkpoint.js';

export {
  deliveryConfirmationStatusSchema,
  deliverySchema,
  deliveryTargetTypeSchema,
  type Delivery,
  type DeliveryConfirmationStatus,
  type DeliveryTargetType,
} from './delivery.js';

export { equipSchema, equipStatusSchema, type Equip, type EquipStatus } from './equip.js';

export {
  fowlerQuadrantSchema,
  holdKindSchema,
  holdSchema,
  holdSeveritySchema,
  holdStatusSchema,
  type FowlerQuadrant,
  type Hold,
  type HoldKind,
  type HoldSeverity,
  type HoldStatus,
} from './hold.js';

export {
  intendedDirectionSchema,
  intendedDirectionStatusSchema,
  type IntendedDirection,
  type IntendedDirectionStatus,
} from './intended-direction.js';

export { uuidSchema, uuidv7, uuidv7Schema, uuidv7Timestamp } from './ids.js';

export {
  participantSchema,
  participantTypeSchema,
  type Participant,
  type ParticipantType,
} from './participant.js';

export { projectSchema, projectStatusSchema, type Project, type ProjectStatus } from './project.js';

export { taskspaceSchema, type TaskSpace } from './taskspace.js';

export { textSchema } from './text.js';

export { instantSchema } from './time.js';

export {
  interventionModeSchema,
  interventionSessionSchema,
  workRunSchema,
  workRunStatusSchema,
  type InterventionMode,
  type InterventionSession,
  type WorkRun,
  type WorkRunStatus,
} from './workrun.js';

export { workSchema, workStatusSchema, type Work, type WorkStatus } from './work.js';
