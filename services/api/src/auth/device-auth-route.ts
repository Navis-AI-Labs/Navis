import {
  deviceAuthContractSchemaVersion,
  deviceKeyResponseSchema,
  deviceRegistrationRequestSchema,
  deviceRevocationRequestSchema,
  deviceTokenRequestSchema,
  parseDeviceAuthRequest,
  UnsupportedDeviceAuthContractVersionError,
} from '@navis/contracts';
import {
  authenticateKey,
  listDevices,
  pollDeviceToken,
  registerDevice,
  requestDeviceFlow,
  revokeDevice,
  type DeviceAuthDeps,
} from '@navis/application';

import {
  AuthorizationDeniedError,
  BadRequestError,
  UnauthorizedError,
  UnsupportedContractVersionError,
} from '../platform/errors.js';
import type { ServiceRoute } from '../platform/server.js';

/** Device-code requests are public; registration and device operations validate their credentials. */

export interface DeviceAuthRouteDeps {
  readonly deviceFlow: DeviceAuthDeps;
}

/** Maps an unsupported contract-version refusal to the wire problem. */
function parseDeviceAuth(input: unknown): unknown {
  try {
    return parseDeviceAuthRequest(input);
  } catch (error) {
    if (error instanceof UnsupportedDeviceAuthContractVersionError) {
      throw new UnsupportedContractVersionError(error.received, [deviceAuthContractSchemaVersion]);
    }
    /* v8 ignore next 1 -- the version probe is the only thrower in this parse path */
    throw error;
  }
}

/** The Authorization header, or undefined when absent or duplicated. */
function authorizationHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  const value = headers?.['authorization'];
  /* v8 ignore next 1 -- node never delivers an empty header array */
  if (Array.isArray(value)) return value.length === 0 ? undefined : value[0];
  return value;
}

export function deviceCodesRoute(deps: DeviceAuthRouteDeps): ServiceRoute {
  return {
    method: 'POST',
    path: '/api/device/codes',
    requiresBody: true,
    handle: async (input: unknown) => {
      parseDeviceAuth(input);
      return requestDeviceFlow(deps.deviceFlow);
    },
  };
}

export function deviceTokenRoute(deps: DeviceAuthRouteDeps): ServiceRoute {
  return {
    method: 'POST',
    path: '/api/device/token',
    requiresBody: true,
    handle: async (input: unknown) => {
      const request = deviceTokenRequestSchema.parse(parseDeviceAuth(input));
      const session = await pollDeviceToken(deps.deviceFlow, request.device_code);
      if (session === null) return { error: 'expired_token' };
      if (session.outcome === 'pending') {
        return { error: 'authorization_pending', interval: session.interval_seconds };
      }
      if (session.outcome === 'denied') return { error: 'authorization_denied' };
      if (session.outcome === 'expired') return { error: 'expired_token' };
      return {
        access_token: session.access_token,
        token_type: 'Bearer' as const,
        expires_in: 3600,
        refresh_token: session.refresh_token,
        participant_id: session.participant_id,
      };
    },
  };
}

export function registerDeviceRoute(deps: DeviceAuthRouteDeps): ServiceRoute {
  return {
    method: 'POST',
    path: '/api/devices',
    requiresBody: true,
    handle: async (
      input: unknown,
      _context: unknown,
      headers?: Record<string, string | string[] | undefined>,
    ) => {
      const request = deviceRegistrationRequestSchema.parse(parseDeviceAuth(input));
      const token = authorizationHeader(headers);
      if (token === undefined) throw new BadRequestError('missing authorization');
      const bearer = token.startsWith('Bearer ') ? token.slice('Bearer '.length) : '';
      const device = await registerDevice(deps.deviceFlow, bearer, request.name);
      if (device === null) throw new BadRequestError('device-auth/authorization-denied');
      return deviceKeyResponseSchema.parse({
        key_id: device.key_id,
        device_id: device.device_id,
        key_secret: device.key_secret,
        issued_at: device.issued_at,
      });
    },
  };
}

/** Device management requires a live key before target ownership can be evaluated. */
async function authenticatedParticipant(
  deps: DeviceAuthRouteDeps,
  headers: Record<string, string | string[] | undefined> | undefined,
): Promise<{ participantId: string }> {
  const header = authorizationHeader(headers);
  if (header === undefined) throw new UnauthorizedError('device-auth/key-invalid');
  const auth = await authenticateKey(deps.deviceFlow, header);
  if (auth.outcome !== 'authenticated') {
    throw new UnauthorizedError(
      auth.outcome === 'device_revoked' ? 'device-auth/device-revoked' : 'device-auth/key-invalid',
    );
  }
  return { participantId: auth.participant_id };
}

export function revokeDeviceRoute(deps: DeviceAuthRouteDeps): ServiceRoute {
  return {
    method: 'DELETE',
    path: '/api/devices/:deviceId',
    requiresBody: true,
    handle: async (
      input: unknown,
      _context: unknown,
      headers?: Record<string, string | string[] | undefined>,
    ) => {
      // the path param is the device id; the body carries only the reason
      const params = input as Record<string, unknown>;
      const request = deviceRevocationRequestSchema.parse(
        parseDeviceAuth({ device_id: params['deviceId'], reason: params['reason'] }),
      );
      const caller = await authenticatedParticipant(deps, headers);
      const revoked = await revokeDevice(
        deps.deviceFlow,
        request.device_id,
        request.reason ?? null,
        caller.participantId,
      );
      if (!revoked) throw new AuthorizationDeniedError();
      return { device_id: request.device_id, revoked: true };
    },
  };
}

export function listDevicesRoute(deps: DeviceAuthRouteDeps): ServiceRoute {
  return {
    method: 'GET',
    path: '/api/devices',
    requiresBody: false,
    handle: async (
      _input: unknown,
      _context: unknown,
      headers?: Record<string, string | string[] | undefined>,
    ) => {
      const caller = await authenticatedParticipant(deps, headers);
      const devices = await listDevices(deps.deviceFlow, caller.participantId);
      return {
        devices: devices.map((d) => ({
          device_id: d.id,
          name: d.name,
          created_at: d.created_at,
          ...(d.last_seen_at === null ? {} : { last_seen_at: d.last_seen_at }),
          ...(d.revoked_at === null ? {} : { revoked_at: d.revoked_at }),
        })),
      };
    },
  };
}

/** All device-auth routes for the composition root. */
export function deviceAuthRoutes(deps: DeviceAuthRouteDeps): readonly ServiceRoute[] {
  return [
    deviceCodesRoute(deps),
    deviceTokenRoute(deps),
    registerDeviceRoute(deps),
    revokeDeviceRoute(deps),
    listDevicesRoute(deps),
  ];
}
