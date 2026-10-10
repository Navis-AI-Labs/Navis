import { AsyncLocalStorage } from 'node:async_hooks';

import type { DeviceAuthPort, EventStore, ProjectDirectory } from '@navis/domain';

import { deviceAuthRoutes } from '../auth/device-auth-route.js';
import { withDeviceAuth, type AuthOptions, type DeviceIdentity } from '../auth/middleware.js';
import { ingestRoute } from '../ingest/route.js';
import { getProjectStateRoute, loadContextRoute, searchProjectsRoute } from '../query/routes.js';
import { AuthorizationDeniedError } from './errors.js';
import type { ServiceRoute } from './server.js';

export interface ApiRouteDependencies {
  readonly eventStore: EventStore;
  readonly deviceStore: DeviceAuthPort;
  readonly projectDirectory: ProjectDirectory;
  readonly now: () => string;
  readonly verificationBaseUrl: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ingestProjectIds(input: unknown): readonly string[] {
  const events = record(input)?.['events'];
  if (!Array.isArray(events)) return [];
  return events.flatMap((entry: unknown) => {
    const projectId = record(record(entry)?.['event'])?.['project_id'];
    return typeof projectId === 'string' ? [projectId] : [];
  });
}

/** The service and its integration tests share this authenticated route composition. */
export function createApiRoutes(deps: ApiRouteDependencies): readonly ServiceRoute[] {
  // Query callbacks must retain the caller across awaits and concurrent requests.
  const identities = new AsyncLocalStorage<{ value?: DeviceIdentity }>();
  const deviceFlow = {
    store: deps.deviceStore,
    now: deps.now,
    verificationBaseUrl: deps.verificationBaseUrl,
  };
  const verified = (route: ServiceRoute, options: AuthOptions = {}): ServiceRoute => {
    const holder = (identity: DeviceIdentity): void => {
      const scope = identities.getStore();
      if (scope !== undefined) scope.value = identity;
    };
    const guarded = withDeviceAuth({ deviceFlow, projectDirectory: deps.projectDirectory }, route, {
      ...options,
      identitySink: holder,
    });
    return {
      ...guarded,
      handle: (input, context, headers) =>
        identities.run({}, () => guarded.handle(input, context, headers)),
    };
  };
  const queries = {
    eventStore: deps.eventStore,
    projectDirectory: deps.projectDirectory,
    participantId: () => identities.getStore()?.value?.participantId ?? null,
  };
  const ingest = ingestRoute({
    eventStore: deps.eventStore,
    now: deps.now,
    verifyPayloadHash: true,
  });
  const boundIngest: ServiceRoute = {
    ...ingest,
    handle(input, context, headers) {
      const claimedDevice = record(input)?.['device_id'];
      if (
        typeof claimedDevice === 'string' &&
        claimedDevice !== identities.getStore()?.value?.deviceId
      ) {
        throw new AuthorizationDeniedError();
      }
      return ingest.handle(input, context, headers);
    },
  };

  return [
    ...deviceAuthRoutes({ deviceFlow }),
    verified(boundIngest, { extractProjectIds: ingestProjectIds }),
    verified(getProjectStateRoute(queries)),
    verified(loadContextRoute(queries)),
    verified(searchProjectsRoute(queries)),
  ];
}
