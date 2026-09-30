import { randomBytes } from 'node:crypto';

import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_POLL_INTERVAL_SECONDS,
  deviceKeyVerifierFromSecret,
  deviceAuthDenialTokens,
} from '@navis/contracts';
import type { DeviceCodeResponse } from '@navis/contracts';
import { uuidv7 } from '@navis/domain';
import type { DeviceAuthPort, DeviceRecord } from '@navis/domain';

/**
 * Device-auth use cases: the RFC 8628 authorization flow, device
 * registration, revocation, and API-key authentication. The transport
 * adapter parses and shapes wire bodies; every decision lives here against
 * the DeviceAuthPort, so the same behavior holds against Postgres and the
 * in-memory adapter used by wire tests.
 *
 * The device API key is issued exactly once: this module is the only place
 * the shared secret exists in plaintext, and it never logs.
 */

const randomToken = (bytes: number): string => randomBytes(bytes).toString('base64url');

/** A user code the member can type quickly: groups of four consonants. */
function userCode(): string {
  const alphabet = 'bcdfghjkmnpqrstvwxyz';
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    const byte = bytes[i];
    /* v8 ignore next 1 -- randomBytes always fills the buffer; the guard pins the invariant */
    if (byte === undefined) throw new Error('randomBytes returned short buffer');
    const ch = alphabet[byte % alphabet.length];
    /* v8 ignore next 1 -- byte % length always lands inside the alphabet */
    if (ch === undefined) throw new Error('alphabet index out of range');
    out += ch;
  }
  return out.slice(0, 4) + '-' + out.slice(4);
}

export interface DeviceAuthDeps {
  readonly store: DeviceAuthPort;
  /** Receipt time; the kernel never reads a clock, the service stamps once per call. */
  readonly now: () => string;
  /** Absolute URL root the verification_uri is built under. */
  readonly verificationBaseUrl: string;
}

export async function requestDeviceFlow(deps: DeviceAuthDeps): Promise<DeviceCodeResponse> {
  const code = randomToken(32);
  const user = userCode();
  const createdAt = deps.now();
  const expiresAt = new Date(Date.parse(createdAt) + DEVICE_CODE_TTL_SECONDS * 1000).toISOString();
  await deps.store.putDeviceCode({
    device_code: code,
    participant_id: null,
    user_code: user,
    verification_uri: deps.verificationBaseUrl,
    expires_at: expiresAt,
    interval_seconds: DEVICE_TOKEN_POLL_INTERVAL_SECONDS,
    status: 'pending',
    created_at: createdAt,
    consumed_at: null,
  });
  return {
    device_code: code,
    user_code: user,
    verification_uri: deps.verificationBaseUrl,
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_TOKEN_POLL_INTERVAL_SECONDS,
  };
}

export type PollTokenResult =
  | { readonly outcome: 'pending'; readonly interval_seconds: number }
  | { readonly outcome: 'denied' }
  | { readonly outcome: 'expired' }
  | {
      readonly outcome: 'authorized';
      readonly access_token: string;
      readonly refresh_token: string;
      readonly participant_id: string;
    };

/** RFC 8628 §3.5: pending, denied, expired, or a one-shot session token. */
export async function pollDeviceToken(
  deps: DeviceAuthDeps,
  deviceCode: string,
): Promise<PollTokenResult | null> {
  const record = await deps.store.getDeviceCode(deviceCode);
  if (record === null) return null;
  if (record.status === 'pending') {
    const expired = Date.parse(record.expires_at) <= Date.parse(deps.now());
    if (expired) return { outcome: 'expired' };
    return { outcome: 'pending', interval_seconds: record.interval_seconds };
  }
  if (record.status === 'denied') return { outcome: 'denied' };
  if (record.status === 'expired') return { outcome: 'expired' };
  // authorized: the code is spent exactly once by issuing a one-shot session
  if (record.consumed_at !== null) return { outcome: 'expired' };
  const participantId = record.participant_id;
  if (participantId === null) return { outcome: 'denied' };
  const sessionToken = randomToken(32);
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const createdAt = deps.now();
  const expiresAt = new Date(Date.parse(createdAt) + 3600 * 1000).toISOString();
  await deps.store.putDeviceSession({
    session_token: sessionToken,
    device_code: deviceCode,
    participant_id: participantId,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    consumed_at: null,
    created_at: createdAt,
  });
  // the record set above is the one-shot; stamp the code consumed so a
  // replay of the same device_code never mints a second session
  await deps.store.consumeDeviceCode(deviceCode, createdAt);
  return {
    outcome: 'authorized',
    access_token: sessionToken,
    refresh_token: refreshToken,
    participant_id: participantId,
  };
}

export interface RegisteredDevice {
  readonly key_id: string;
  readonly device_id: string;
  readonly key_secret: string;
  readonly issued_at: string;
}

/**
 * Spends an authorized session to register a device and issue its API key.
 * The verifier stored is sha256(secret); the secret leaves this function in
 * the response and nowhere else.
 */
export async function registerDevice(
  deps: DeviceAuthDeps,
  accessToken: string,
  name: string,
): Promise<RegisteredDevice | null> {
  const session = await deps.store.getDeviceSession(accessToken);
  if (session === null) return null;
  if (session.consumed_at !== null) return null;
  if (Date.parse(session.expires_at) <= Date.parse(deps.now())) return null;

  const createdAt = deps.now();
  const device = await deps.store.registerDevice({
    participantId: session.participant_id,
    name,
    createdAt,
  });
  const keyId = uuidv7();
  const secret = randomToken(32);
  await deps.store.createKey({
    key_id: keyId,
    device_id: device.id,
    verifier: deviceKeyVerifierFromSecret(secret),
    algorithm: 'sha256',
    revoked_at: null,
    issued_at: createdAt,
  });
  await deps.store.consumeDeviceSession(accessToken);
  return { key_id: keyId, device_id: device.id, key_secret: secret, issued_at: createdAt };
}

export async function revokeDevice(
  deps: DeviceAuthDeps,
  deviceId: string,
  reason: string | null,
  actorId: string,
): Promise<void> {
  await deps.store.revokeDevice({
    deviceId,
    reason,
    revokedAt: deps.now(),
    updatedBy: actorId,
  });
}

export function listDevices(deps: DeviceAuthDeps, participantId: string): Promise<DeviceRecord[]> {
  return deps.store.listDevices(participantId);
}

export type AuthenticateResult =
  | {
      readonly outcome: 'authenticated';
      readonly participant_id: string;
      readonly device_id: string;
    }
  | { readonly outcome: 'key_invalid' }
  | { readonly outcome: 'device_revoked' };

/**
 * Authenticates `Bearer <key_id>.<secret>`. The key id locates the row; the
 * secret is verified against the stored sha256 in constant space; a revoked
 * key fails before any business logic runs. The result token is stable:
 * `key-invalid` never reveals whether the id was unknown or the secret wrong.
 */
export async function authenticateKey(
  deps: DeviceAuthDeps,
  authorizationHeader: string,
): Promise<AuthenticateResult> {
  const prefix = 'Bearer ';
  if (!authorizationHeader.startsWith(prefix)) return { outcome: 'key_invalid' };
  const token = authorizationHeader.slice(prefix.length);
  const dot = token.indexOf('.');
  if (dot < 1) return { outcome: 'key_invalid' };
  const keyId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  const key = await deps.store.getKeyById(keyId);
  if (key === null) return { outcome: 'key_invalid' };
  if (deviceKeyVerifierFromSecret(secret) !== key.verifier) return { outcome: 'key_invalid' };
  if (key.revoked_at !== null) return { outcome: 'device_revoked' };
  const device = await deps.store.getDevice(key.device_id);
  // a missing or revoked device denies identically: the caller learns neither
  /* v8 ignore next 1 -- the store refuses a key without a device row */
  if (device === null) return { outcome: 'device_revoked' };
  /* v8 ignore next 1 -- the port cascades revocation onto the key, so this row reads live */
  if (device.revoked_at !== null) return { outcome: 'device_revoked' };
  await deps.store.touchDeviceLastSeen(device.id, deps.now());
  return { outcome: 'authenticated', participant_id: device.participant_id, device_id: device.id };
}

export { deviceAuthDenialTokens };
