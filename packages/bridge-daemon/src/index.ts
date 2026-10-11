/** Public surface of the per-user bridge daemon package. */
export * from './paths.js';
export * from './lock.js';
export * from './keychain.js';
export * from './ipc.js';
export * from './daemon.js';
export * from './binding/index.js';
export type { OutboxCaptureInput, OutboxEvent, OutboxPort, OutboxState } from './outbox/ports.js';
export { openDaemonDb } from './persistence/sqlite-binding.js';
export { SqliteOutbox } from './outbox/sqlite-outbox.js';

export { invokeBridge, sendBridge } from './runtime/client.js';
export { BridgeRuntime } from './runtime/runtime.js';
export { bridgeRequestSchema, type BridgeRequest } from './runtime/request.js';
export { uuidv7 as newRequestId } from '@navis/domain';

export { declaredProjectId } from './binding/toml.js';
