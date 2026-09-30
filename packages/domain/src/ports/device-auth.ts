/**
 * Device authentication port — the domain's view of the RFC 8628 device
 * authorization flow plus device-key authentication.
 *
 * The port sits at the domain boundary: the application composes the flow
 * (request code → user authorizes → poll → register device), and the
 * infrastructure adapters persist the same records in Postgres or in memory
 * for tests. Records are plain data: one-way verifiers, never key secrets.
 *
 * Deny semantics are the default: any lookup that does not find a live row
 * returns null, and authentication failure carries a stable token, not a
 * reason that distinguishes unknown-device from revoked-device to outsiders.
 */

export type DeviceCodeStatus = 'pending' | 'authorized' | 'denied' | 'expired';

/** RFC 8628 device authorization grant record. */
export interface DeviceCodeRecord {
  readonly device_code: string;
  readonly participant_id: string | null;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_at: string;
  readonly interval_seconds: number;
  readonly status: DeviceCodeStatus;
  readonly created_at: string;
  readonly consumed_at: string | null;
}

/**
 * The one-shot session issued after a device code is authorized. The daemon
 * spends it to register a device, then the session is consumed and never
 * usable again.
 */
export interface DeviceSessionRecord {
  readonly session_token: string;
  readonly device_code: string;
  readonly participant_id: string;
  readonly access_token: string;
  readonly refresh_token: string | null;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly created_at: string;
}

/** One registered device, as persisted. Never carries a key or verifier. */
export interface DeviceRecord {
  readonly id: string;
  readonly participant_id: string;
  readonly name: string;
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
  readonly last_seen_at: string | null;
  readonly created_at: string;
}

/** A device API key row: the verifier is the sha256 of the issued secret. */
export interface DeviceKeyRecord {
  readonly key_id: string;
  readonly device_id: string;
  readonly verifier: string;
  readonly algorithm: 'sha256';
  readonly revoked_at: string | null;
  readonly issued_at: string;
}

export interface DeviceAuthPort {
  /* -- RFC 8628 device code flow ---------------------------------------- */

  /** Persists a fresh code; the device_code column is the key. */
  putDeviceCode(record: DeviceCodeRecord): Promise<void>;
  getDeviceCode(deviceCode: string): Promise<DeviceCodeRecord | null>;
  /** Marks a pending code authorized to a participant (deny is a status too). */
  authorizeDeviceCode(
    deviceCode: string,
    participantId: string,
    status: 'authorized' | 'denied',
  ): Promise<void>;
  /** Stamps issued → consumed: the code never authorizes a second session. */
  consumeDeviceCode(deviceCode: string, consumedAt: string): Promise<void>;

  /* -- the one-shot session a daemon spends to register a device --------- */

  putDeviceSession(record: DeviceSessionRecord): Promise<void>;
  getDeviceSession(sessionToken: string): Promise<DeviceSessionRecord | null>;
  /** Consumed at registration; a consumed session never authorizes again. */
  consumeDeviceSession(sessionToken: string): Promise<void>;

  /* -- device registry ---------------------------------------------------- */

  registerDevice(input: {
    participantId: string;
    name: string;
    createdAt: string;
  }): Promise<DeviceRecord>;
  getDevice(deviceId: string): Promise<DeviceRecord | null>;
  listDevices(participantId: string): Promise<DeviceRecord[]>;
  /** Revokes immediately: the device's live key dies in the same statement. */
  revokeDevice(input: {
    deviceId: string;
    reason: string | null;
    revokedAt: string;
    updatedBy: string;
  }): Promise<void>;

  /* -- device API keys ---------------------------------------------------- */

  createKey(record: DeviceKeyRecord): Promise<void>;
  /** Lookup is by key id; authentication compares the stored verifier. */
  getKeyById(keyId: string): Promise<DeviceKeyRecord | null>;
  touchDeviceLastSeen(deviceId: string, seenAt: string): Promise<void>;
}
