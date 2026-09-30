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

import { BadRequestError, UnsupportedContractVersionError } from '../platform/errors.js';
import type { ServiceRoute } from '../platform/server.js';

/**
 * Device-auth routes (spec: authentication establishes device identity).
 *
 * RFC 8628 lives at these four endpoints plus the device registry:
 *
 * - `POST /api/device/codes` — starts the flow; unauthenticated by design
 *   (the device has no credential yet), rate limiting is a transport concern.
 * - `POST /api/device/token` — the daemon polls; pending/denied/expired map
 *   to the RFC error tokens inside a 200 envelope per this surface's shape.
 * - `POST /api/devices` — the one-shot session token authorizes registration
 *   exactly once; the API key secret appears in this response and never again.
 * - `DELETE /api/devices/:deviceId` — member-side revocation; the caller is
 *   the device's own participant, resolved from the key, never from the URL.
 *
 * `GET /api/devices` lists the caller's devices and never returns secrets.
 * Until task 5.2 installs the membership middleware, member-side endpoints
 * take the participant from the authenticated device key on the request.
 */

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

/** Authorizes a member-side request by its device key; null means deny. */
async function authenticatedParticipant(
  deps: DeviceAuthRouteDeps,
  headers: Record<string, string | string[] | undefined> | undefined,
): Promise<{ participantId: string } | null> {
  const header = authorizationHeader(headers);
  if (header === undefined) return null;
  const auth = await authenticateKey(deps.deviceFlow, header);
  if (auth.outcome !== 'authenticated') return null;
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
      if (caller === null) return { device_id: request.device_id, revoked: false };
      await revokeDevice(
        deps.deviceFlow,
        request.device_id,
        request.reason ?? null,
        caller.participantId,
      );
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
      if (caller === null) return { devices: [] };
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
