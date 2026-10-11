import type { DeviceAuthTransaction } from '@navis/application';
import type postgres from 'postgres';
import { instantSchema } from '@navis/domain';

import type {
  DeviceAuthPort,
  DeviceCodeRecord,
  DeviceCodeStatus,
  DeviceKeyRecord,
  DeviceRecord,
  DeviceSessionRecord,
} from '@navis/domain';

/** Text fields must remain strings; date conversion belongs only to timestamp columns. */
function asText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('expected a text column');
  return value;
}

function asTextOrNull(value: unknown): string | null {
  if (value === null) return null;
  return asText(value);
}

/** postgres.js returns timestamptz as Date; ports carry validated UTC instants. */
function asInstant(value: unknown): string {
  const parsed = instantSchema.safeParse(value instanceof Date ? value.toISOString() : value);
  if (!parsed.success) throw new Error('expected a timestamp column');
  return parsed.data;
}

function asInstantOrNull(value: unknown): string | null {
  return value === null ? null : asInstant(value);
}

/** Active-key uniqueness and revocation cascades are enforced by the database. */
export class PostgresDeviceAuth implements DeviceAuthPort {
  constructor(private readonly sql: postgres.Sql) {}

  async putDeviceCode(record: DeviceCodeRecord): Promise<void> {
    await this.sql`
      INSERT INTO device_codes (
        device_code, participant_id, user_code, verification_uri,
        expires_at, interval_seconds, status, created_at, consumed_at
      ) VALUES (
        ${record.device_code}, ${record.participant_id}, ${record.user_code},
        ${record.verification_uri}, ${record.expires_at}, ${record.interval_seconds},
        ${record.status}, ${record.created_at}, ${record.consumed_at}
      )
    `;
  }

  async getDeviceCode(deviceCode: string): Promise<DeviceCodeRecord | null> {
    const rows = await this.sql`
      SELECT device_code, participant_id, user_code, verification_uri,
             expires_at, interval_seconds, status, created_at, consumed_at
      FROM device_codes
      WHERE device_code = ${deviceCode}
      FOR UPDATE
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      device_code: asText(row['device_code']),
      participant_id: asTextOrNull(row['participant_id']),
      user_code: asText(row['user_code']),
      verification_uri: asText(row['verification_uri']),
      expires_at: asInstant(row['expires_at']),
      interval_seconds: Number(row['interval_seconds']),
      status: row['status'] as DeviceCodeStatus,
      created_at: asInstant(row['created_at']),
      consumed_at: asInstantOrNull(row['consumed_at']),
    };
  }

  async authorizeDeviceCode(
    deviceCode: string,
    participantId: string,
    status: 'authorized' | 'denied',
  ): Promise<void> {
    await this.sql`
      UPDATE device_codes
      SET participant_id = ${participantId}, status = ${status}
      WHERE device_code = ${deviceCode} AND status = 'pending'
    `;
  }

  async consumeDeviceCode(deviceCode: string, consumedAt: string): Promise<void> {
    await this.sql`
      UPDATE device_codes
      SET consumed_at = ${consumedAt}
      WHERE device_code = ${deviceCode} AND consumed_at IS NULL
    `;
  }

  async putDeviceSession(record: DeviceSessionRecord): Promise<void> {
    await this.sql`
      INSERT INTO device_sessions (
        session_token, device_code, participant_id, access_token,
        refresh_token, expires_at, consumed_at, created_at
      ) VALUES (
        ${record.session_token}, ${record.device_code}, ${record.participant_id},
        ${record.access_token}, ${record.refresh_token}, ${record.expires_at},
        ${record.consumed_at}, ${record.created_at}
      )
    `;
  }

  async getDeviceSession(sessionToken: string): Promise<DeviceSessionRecord | null> {
    const rows = await this.sql`
      SELECT session_token, device_code, participant_id, access_token,
             refresh_token, expires_at, consumed_at, created_at
      FROM device_sessions
      WHERE session_token = ${sessionToken}
      FOR UPDATE
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      session_token: asText(row['session_token']),
      device_code: asText(row['device_code']),
      participant_id: asText(row['participant_id']),
      access_token: asText(row['access_token']),
      refresh_token: asTextOrNull(row['refresh_token']),
      expires_at: asInstant(row['expires_at']),
      consumed_at: asInstantOrNull(row['consumed_at']),
      created_at: asInstant(row['created_at']),
    };
  }

  async consumeDeviceSession(sessionToken: string): Promise<void> {
    await this.sql`
      UPDATE device_sessions
      SET consumed_at = now()
      WHERE session_token = ${sessionToken} AND consumed_at IS NULL
    `;
  }

  async registerDevice(input: {
    participantId: string;
    name: string;
    createdAt: string;
  }): Promise<DeviceRecord> {
    const rows = await this.sql`
      INSERT INTO devices (id, participant_id, name, created_at)
      VALUES (gen_random_uuid(), ${input.participantId}, ${input.name}, ${input.createdAt})
      RETURNING id, participant_id, name, revoked_at, revoke_reason, last_seen_at, created_at
    `;
    const row = rows[0] as Record<string, unknown>;
    return this.toDevice(row);
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | null> {
    const rows = await this.sql`
      SELECT id, participant_id, name, revoked_at, revoke_reason, last_seen_at, created_at
      FROM devices
      WHERE id = ${deviceId} AND deleted_at IS NULL
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : this.toDevice(row);
  }

  async listDevices(participantId: string): Promise<DeviceRecord[]> {
    const rows = await this.sql`
      SELECT id, participant_id, name, revoked_at, revoke_reason, last_seen_at, created_at
      FROM devices
      WHERE participant_id = ${participantId} AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => this.toDevice(row as Record<string, unknown>));
  }

  async revokeDevice(input: {
    deviceId: string;
    reason: string | null;
    revokedAt: string;
    updatedBy: string;
  }): Promise<void> {
    // the table trigger cascades revoked_at onto the device's live keys, so
    // authentication fails on the very next request without a second write
    await this.sql`
      UPDATE devices
      SET revoked_at = ${input.revokedAt}, revoke_reason = ${input.reason},
          updated_at = ${input.revokedAt}, updated_by = ${input.updatedBy}
      WHERE id = ${input.deviceId} AND revoked_at IS NULL
    `;
  }

  async createKey(record: DeviceKeyRecord): Promise<void> {
    await this.sql`
      INSERT INTO device_keys (key_id, device_id, verifier, algorithm, issued_at)
      VALUES (
        ${record.key_id}, ${record.device_id}, ${record.verifier},
        ${record.algorithm}, ${record.issued_at}
      )
    `;
  }

  async getKeyById(keyId: string): Promise<DeviceKeyRecord | null> {
    const rows = await this.sql`
      SELECT key_id, device_id, verifier, algorithm, revoked_at, issued_at
      FROM device_keys
      WHERE key_id = ${keyId} AND deleted_at IS NULL
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      key_id: asText(row['key_id']),
      device_id: asText(row['device_id']),
      verifier: asText(row['verifier']),
      algorithm: 'sha256',
      revoked_at: row['revoked_at'] === null ? null : asInstant(row['revoked_at']),
      issued_at: asInstant(row['issued_at']),
    };
  }

  async touchDeviceLastSeen(deviceId: string, seenAt: string): Promise<void> {
    await this.sql`
      UPDATE devices
      SET last_seen_at = ${seenAt}, updated_at = ${seenAt}
      WHERE id = ${deviceId}
    `;
  }

  private toDevice(row: Record<string, unknown>): DeviceRecord {
    return {
      id: asText(row['id']),
      participant_id: asText(row['participant_id']),
      name: asText(row['name']),
      revoked_at: row['revoked_at'] === null ? null : asInstant(row['revoked_at']),
      revoke_reason: row['revoke_reason'] === null ? null : asText(row['revoke_reason']),
      last_seen_at: row['last_seen_at'] === null ? null : asInstant(row['last_seen_at']),
      created_at: asInstant(row['created_at']),
    };
  }
}

/** Row locks in the auth adapter serialize consumption of one-shot authorization material. */
export function createDeviceAuthTransaction(sql: postgres.Sql): DeviceAuthTransaction {
  return async <T>(operation: (store: DeviceAuthPort) => Promise<T>): Promise<T> =>
    (await sql.begin((tx) => operation(new PostgresDeviceAuth(tx)))) as T;
}
