export { captureSnapshotIfDue, type CaptureOutcome } from './capture/capture-flow.js';
export {
  authenticateKey,
  listDevices,
  pollDeviceToken,
  registerDevice,
  requestDeviceFlow,
  revokeDevice,
  type AuthenticateResult,
  type DeviceAuthDeps,
  type DeviceAuthTransaction,
  type PollTokenResult,
  type RegisteredDevice,
} from './auth/device-auth-flow.js';
export {
  dispatchCommand,
  type CommandExecutor,
  type DispatchRequest,
  type DispatchResponse,
  type DispatchResultValue,
} from './intake/dispatch-command.js';
export {
  ingestBatch,
  type IngestBatchDeps,
  type IngestBatchRequest,
  type IngestBatchResponse,
  type IngestEventInput,
} from './ingest/ingest-batch.js';
export {
  getProjectState,
  loadContext,
  searchProjects,
  InvalidQueryCursorError,
} from './query/project-query.js';

export {
  ProjectService,
  ProjectOperationError,
  MAX_PROJECT_EVENTS,
} from './project/project-service.js';
export type {
  ProjectWorkspace,
  ProjectTransaction,
  InstancePrincipal,
  ProjectMembership,
} from './ports/project-workspace.js';

export { AssistanceService, ModelProviderError } from './assistance/service.js';
export type { AssistanceJobs, AssistanceJob, ModelProvider } from './ports/assistance.js';

export { provisionDevice } from './auth/provision-device.js';

export { AssistanceCapacityError } from './ports/assistance.js';
