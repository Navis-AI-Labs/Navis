/**
 * Public barrel for the api service. Capability modules live in scoped
 * subdirectories; the process entry (`platform/index.ts`) is side-effect
 * only and deliberately absent from this surface.
 */
export * from './platform/config.js';
export * from './platform/errors.js';
export * from './platform/logging.js';
export type { RequestContext } from './platform/tracing.js';
export * from './platform/server.js';
export * from './auth/device-auth-route.js';
export * from './auth/middleware.js';
export * from './ingest/route.js';
export * from './query/routes.js';
