import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  instantWireSchema,
  labelWireSchema,
  textWireSchema,
  uuidRefSchema,
} from './wire-primitives.js';

/**
 * Device authorization contract — OAuth 2.0 device authorization flow
 * (RFC 8628) plus the Navis device API key model.
 *
 * The flow: a device requests a device code, the user authorizes at a
 * browser on any device, the daemon polls the token endpoint, and
 * registering the device issues a long-lived device API key. The key is
 * returned exactly once, is never logged, and revoking the device
 * invalidates the key immediately — no grace period.
 *
 * Authorization is the project membership table, not repository
 * permissions: a device key authenticates (who + which machine), the
 * membership table authorizes (what this project admits). Deny is default.
 */

/** The device-auth contract version this package supports. */
export const deviceAuthContractSchemaVersion = 1;

/** Device code lifetime, in seconds. RFC 8628: code is short-lived and user-interactive. */
export const DEVICE_CODE_TTL_SECONDS = 60 * 15;

/** Polling cadence the daemon uses between token exchanges. */
export const DEVICE_TOKEN_POLL_INTERVAL_SECONDS = 5;

/**
 * Stable machine-readable denial tokens for the auth boundary. Renaming or
 * reusing a token is a breaking change; human detail belongs in `detail`.
 */
export const deviceAuthDenialTokens = {
  device_pending: 'device-auth/pending',
  device_expired: 'device-auth/expired',
  device_denied: 'device-auth/denied',
  device_slow_down: 'device-auth/slow-down',
  device_revoked: 'device-auth/device-revoked',
  authorization_denied: 'device-auth/authorization-denied',
  key_invalid: 'device-auth/key-invalid',
} as const;

export type DeviceAuthDenialToken = keyof typeof deviceAuthDenialTokens;

/** Human-facing device name, bounded; shown in the member's device list. */
export const deviceNameSchema = labelWireSchema;

/**
 * Device registration request after the device flow completes: the human
 * participant this device belongs to and the name they gave it. The
 * participant is resolved from the completed flow, never trusted from the
 * caller's assertion.
 */
export const deviceRegistrationRequestSchema = z
  .strictObject({
    name: deviceNameSchema,
  })
  .meta({
    description: 'Device registration after a completed device flow.',
    id: 'DeviceRegistrationRequest',
  });

/**
 * The issued device API key. Returned exactly once; the service stores only
 * the key's verifier (a one-way hash). `key_id` is the stable identifier the
 * member uses to manage the device; the secret itself is never present in
 * any subsequent response, log, or audit record.
 */
export const deviceKeyResponseSchema = z
  .looseObject({
    key_id: uuidRefSchema,
    device_id: uuidRefSchema,
    key_secret: z.string().min(32).max(128),
    issued_at: instantWireSchema,
  })
  .meta({ description: 'Device API key issued once at registration.', id: 'DeviceKeyResponse' });

/**
 * The verifier a stored key reduces to. The wire never carries this; the
 * service persists it and compares in constant time.
 */
export const deviceKeyVerifierSchema = z
  .strictObject({
    key_id: uuidRefSchema,
    verifier: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
    algorithm: z.literal('sha256'),
  })
  .meta({
    description: 'Persisted one-way verifier for a device API key.',
    id: 'DeviceKeyVerifier',
  });

/** The device code the user must authorize at a browser. */
export const deviceCodeResponseSchema = z
  .looseObject({
    device_code: z.string().min(16).max(256),
    user_code: z.string().min(4).max(64),
    verification_uri: z.string().min(1).max(2048),
    verification_uri_complete: z.string().min(1).max(2048).optional(),
    expires_in: z.number().int().min(60).max(DEVICE_CODE_TTL_SECONDS),
    interval: z.number().int().min(1).max(60),
  })
  .meta({ description: 'RFC 8628 device authorization response.', id: 'DeviceCodeResponse' });

/** Token exchange request: the daemon polls with its device code. */
export const deviceTokenRequestSchema = z
  .strictObject({
    grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
    device_code: z.string().min(16).max(256),
  })
  .meta({ description: 'RFC 8628 token exchange request.', id: 'DeviceTokenRequest' });

/**
 * Token exchange response. On completion the client immediately registers a
 * device and exchanges this short-lived access token for a device API key.
 */
export const deviceTokenResponseSchema = z
  .looseObject({
    access_token: z.string().min(1).max(4096),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().min(60).max(86400),
    refresh_token: z.string().min(1).max(4096).optional(),
    participant_id: uuidRefSchema,
  })
  .meta({ description: 'RFC 8628 token exchange response.', id: 'DeviceTokenResponse' });

/**
 * Device revocation request by the member (or an admin). Revocation is
 * immediate and unconditional: the next request with the revoked key fails
 * with `device-revoked` before any business logic runs.
 */
export const deviceRevocationRequestSchema = z
  .strictObject({
    device_id: uuidRefSchema,
    reason: textWireSchema.optional(),
  })
  .meta({ description: 'Device revocation request.', id: 'DeviceRevocationRequest' });

/** A device in the member's device list. Never includes a key or verifier. */
export const deviceListItemSchema = z
  .looseObject({
    device_id: uuidRefSchema,
    name: deviceNameSchema,
    created_at: instantWireSchema,
    last_seen_at: instantWireSchema.optional(),
    revoked_at: instantWireSchema.optional(),
  })
  .meta({ description: 'One device in a member device listing.', id: 'DeviceListItem' });

export type DeviceCodeResponse = z.infer<typeof deviceCodeResponseSchema>;
export type DeviceTokenRequest = z.infer<typeof deviceTokenRequestSchema>;
export type DeviceTokenResponse = z.infer<typeof deviceTokenResponseSchema>;
export type DeviceKeyResponse = z.infer<typeof deviceKeyResponseSchema>;
export type DeviceKeyVerifier = z.infer<typeof deviceKeyVerifierSchema>;
export type DeviceRegistrationRequest = z.infer<typeof deviceRegistrationRequestSchema>;
export type DeviceRevocationRequest = z.infer<typeof deviceRevocationRequestSchema>;
export type DeviceListItem = z.infer<typeof deviceListItemSchema>;

/**
 * Thrown when a device-auth request declares a contract version this
 * package does not support. Version refusal is explicit, never a partial parse.
 */
export class UnsupportedDeviceAuthContractVersionError extends Error {
  override readonly name = 'UnsupportedDeviceAuthContractVersionError' as const;
  readonly received: number;
  readonly supported: number;
  constructor(received: number, supported: number) {
    super(
      `unsupported device-auth contract_version: received ${String(received)}, supported up to ${String(supported)}`,
    );
    this.received = received;
    this.supported = supported;
  }
}

/* Version precheck: refuse an unsupported contract version before any
 * credential is inspected. */
const deviceAuthVersionProbeSchema = z.looseObject({
  contract_version: z.number().int().positive(),
});

/** Consumer path for a device-auth request. */
export function parseDeviceAuthRequest(input: unknown): unknown {
  const probe = deviceAuthVersionProbeSchema.safeParse(input);
  if (probe.success && probe.data.contract_version > deviceAuthContractSchemaVersion) {
    throw new UnsupportedDeviceAuthContractVersionError(
      probe.data.contract_version,
      deviceAuthContractSchemaVersion,
    );
  }
  return input;
}

/**
 * Verifier for a freshly issued device key secret: sha256 hex lowercase.
 * The service persists only this verifier; the secret is returned once at
 * registration and never recoverable.
 */
export function deviceKeyVerifierFromSecret(keySecret: string): string {
  return createHash('sha256').update(keySecret, 'utf8').digest('hex');
}
