import { uuidRefSchema } from '@navis/contracts';
import { authenticateKey, type AuthenticateResult, type DeviceAuthDeps } from '@navis/application';
import type { ProjectDirectory } from '@navis/domain';

import { AuthorizationDeniedError, UnauthorizedError } from '../platform/errors.js';
import type { ServiceRoute } from '../platform/server.js';

/** Authentication resolves identity; resource membership is checked before the route runs. */

/** The verified identity a wrapped route sees alongside its input. */
export interface DeviceIdentity {
  readonly participantId: string;
  readonly deviceId: string;
}

export interface AuthMiddlewareDeps {
  readonly deviceFlow: DeviceAuthDeps;
  readonly projectDirectory: ProjectDirectory;
}

/** Project ids the gate must check: path param by default, events for ingest. */
export interface AuthOptions {
  readonly extractProjectIds?: (input: unknown) => readonly string[];
  /**
   * Composition seam: fires after the key authenticates, so the caller-side
   * wiring can bind the verified identity into the wrapped route's deps.
   * The wrapper stays identity-agnostic; the route never re-reads a header.
   */
  readonly identitySink?: (identity: DeviceIdentity) => void;
}

function authorizationHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  const value = headers?.['authorization'];
  /* v8 ignore next 1 -- node never delivers an empty header array */
  if (Array.isArray(value)) return value.length === 0 ? undefined : value[0];
  return value;
}

/** Maps the port's denial into the wire-denial token (constant shape). */
function denied(result: AuthenticateResult): never {
  if (result.outcome === 'device_revoked')
    throw new UnauthorizedError('device-auth/device-revoked');
  if (result.outcome === 'key_invalid') throw new UnauthorizedError('device-auth/key-invalid');
  /* v8 ignore next 1 -- 'authenticated' never reaches the deny path */
  throw new UnauthorizedError('device-auth/key-invalid');
}

/** Binds verified identity through the composition callback after membership checks. */
export function withDeviceAuth(
  deps: AuthMiddlewareDeps,
  route: ServiceRoute,
  options: AuthOptions = {},
): ServiceRoute {
  return {
    method: route.method,
    path: route.path,
    requiresBody: route.requiresBody,
    handle: async (input, context, headers) => {
      const header = authorizationHeader(headers);
      if (header === undefined) throw new UnauthorizedError('device-auth/key-invalid');
      const auth = await authenticateKey(deps.deviceFlow, header);
      if (auth.outcome !== 'authenticated') return denied(auth);

      // every project the request touches must be one the participant holds
      const projectIds = options.extractProjectIds?.(input) ?? pathProjectId(input);
      for (const projectId of projectIds) {
        if (!(await deps.projectDirectory.isMember(auth.participant_id, projectId))) {
          throw new AuthorizationDeniedError();
        }
      }
      options.identitySink?.({ participantId: auth.participant_id, deviceId: auth.device_id });
      return route.handle(input, context, headers);
    },
  };
}

function pathProjectId(input: unknown): readonly string[] {
  if (input === null || typeof input !== 'object') return [];
  const projectId = (input as Record<string, unknown>)['projectId'];
  return projectId === undefined ? [] : [uuidRefSchema.parse(projectId)];
}
