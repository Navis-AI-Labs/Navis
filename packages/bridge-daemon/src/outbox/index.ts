/** Outbox: the machine-local buffer behind the port boundary. */
export type { OutboxEvent, OutboxPort, OutboxState, OutboxCaptureInput } from './ports.js';
export { SqliteOutbox } from './sqlite-outbox.js';
