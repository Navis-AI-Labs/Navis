import { uuidv7 } from '@navis/domain';
import type {
  DeviceAuthPort,
  DeviceCodeRecord,
  DeviceKeyRecord,
  DeviceRecord,
  DeviceSessionRecord,
} from '@navis/domain';

/**
 * In-memory DeviceAuth: the semantic definition of the port. Every record
 * fields the same values the Postgres tables carry, so a wire test can
 * exercise the full RFC 8628 flow without a database. Key secrets never
 * enter the store — only the sha256 verifier is kept.
 */
export class InMemoryDeviceAuth implements DeviceAuthPort {
  private readonly codes = new Map<string, DeviceCodeRecord>();
  private readonly sessions = new Map<string, DeviceSessionRecord>();
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly keys = new Map<string, DeviceKeyRecord>();

  putDeviceCode(record: DeviceCodeRecord): Promise<void> {
    this.codes.set(record.device_code, record);
    return Promise.resolve();
  }

  getDeviceCode(deviceCode: string): Promise<DeviceCodeRecord | null> {
    return Promise.resolve(this.codes.get(deviceCode) ?? null);
  }

  authorizeDeviceCode(
    deviceCode: string,
    participantId: string,
    status: 'authorized' | 'denied',
  ): Promise<void> {
    const code = this.codes.get(deviceCode);
    if (code === undefined) return Promise.resolve();
    // the supply side resolves the participant once, at authorization time
    this.codes.set(deviceCode, { ...code, participant_id: participantId, status });
    return Promise.resolve();
  }

  consumeDeviceCode(deviceCode: string, consumedAt: string): Promise<void> {
    const code = this.codes.get(deviceCode);
    if (code === undefined) return Promise.resolve();
    this.codes.set(deviceCode, { ...code, consumed_at: consumedAt });
    return Promise.resolve();
  }

  putDeviceSession(record: DeviceSessionRecord): Promise<void> {
    this.sessions.set(record.session_token, record);
    return Promise.resolve();
  }

  getDeviceSession(sessionToken: string): Promise<DeviceSessionRecord | null> {
    return Promise.resolve(this.sessions.get(sessionToken) ?? null);
  }

  consumeDeviceSession(sessionToken: string): Promise<void> {
    const session = this.sessions.get(sessionToken);
    if (session === undefined) return Promise.resolve();
    this.sessions.set(sessionToken, { ...session, consumed_at: session.expires_at });
    return Promise.resolve();
  }

  registerDevice(input: {
    participantId: string;
    name: string;
    createdAt: string;
  }): Promise<DeviceRecord> {
    const device: DeviceRecord = {
      id: uuidv7(),
      participant_id: input.participantId,
      name: input.name,
      revoked_at: null,
      revoke_reason: null,
      last_seen_at: null,
      created_at: input.createdAt,
    };
    this.devices.set(device.id, device);
    return Promise.resolve(device);
  }

  getDevice(deviceId: string): Promise<DeviceRecord | null> {
    return Promise.resolve(this.devices.get(deviceId) ?? null);
  }

  listDevices(participantId: string): Promise<DeviceRecord[]> {
    const list = [...this.devices.values()].filter((d) => d.participant_id === participantId);
    return Promise.resolve(list);
  }

  revokeDevice(input: {
    deviceId: string;
    reason: string | null;
    revokedAt: string;
    updatedBy: string;
  }): Promise<void> {
    const device = this.devices.get(input.deviceId);
    if (device === undefined) return Promise.resolve();
    this.devices.set(input.deviceId, {
      ...device,
      revoked_at: input.revokedAt,
      revoke_reason: input.reason,
    });
    // revocation cascades to the key's stop flag in the same statement, so a
    // hot-path key lookup never needs the device row to know it is dead
    for (const [keyId, key] of this.keys) {
      if (key.device_id === input.deviceId && key.revoked_at === null) {
        this.keys.set(keyId, { ...key, revoked_at: input.revokedAt });
      }
    }
    return Promise.resolve();
  }

  createKey(record: DeviceKeyRecord): Promise<void> {
    this.keys.set(record.key_id, record);
    return Promise.resolve();
  }

  getKeyById(keyId: string): Promise<DeviceKeyRecord | null> {
    return Promise.resolve(this.keys.get(keyId) ?? null);
  }

  touchDeviceLastSeen(deviceId: string, seenAt: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device === undefined) return Promise.resolve();
    this.devices.set(deviceId, { ...device, last_seen_at: seenAt });
    return Promise.resolve();
  }
}
