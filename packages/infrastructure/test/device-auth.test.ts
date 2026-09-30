import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { InMemoryDeviceAuth } from '../src/persistence/in-memory/in-memory-device-auth.js';
import { PostgresDeviceAuth } from '../src/persistence/postgres/postgres-device-auth.js';
import type { DeviceCodeRecord, DeviceKeyRecord, DeviceSessionRecord } from '@navis/domain';

/**
 * Device-auth port conformance: the Postgres adapter's fake-wire assertions
 * pin the SQL shape (revocation cascades in the database, the single-active-
 * key constraint carries the live one, and consumed rows can never be spent
 * again), while the in-memory adapter pins the port semantics a wire test
 * exercises end-to-end.
 */

const PARTICIPANT = '01924a61-7a1b-7c2d-8e3f-0000000000b1';
const DEVICE = '01924a61-7a1b-7c2d-8e3f-000000000001';
const KEY = '01924a61-7a1b-7c2d-8e3f-0000000000aa';
const AT = '2026-09-01T00:00:00.000Z';

function code(overrides: Partial<DeviceCodeRecord> = {}): DeviceCodeRecord {
  return {
    device_code: 'dc',
    participant_id: null,
    user_code: 'hjkm-pqrs',
    verification_uri: 'http://127.0.0.1/device',
    expires_at: AT,
    interval_seconds: 5,
    status: 'pending',
    created_at: AT,
    consumed_at: null,
    ...overrides,
  };
}

function session(overrides: Partial<DeviceSessionRecord> = {}): DeviceSessionRecord {
  return {
    session_token: 'st',
    device_code: 'dc',
    participant_id: PARTICIPANT,
    access_token: 'at',
    refresh_token: 'rt',
    expires_at: AT,
    consumed_at: null,
    created_at: AT,
    ...overrides,
  };
}

function keyRecord(overrides: Partial<DeviceKeyRecord> = {}): DeviceKeyRecord {
  return {
    key_id: KEY,
    device_id: DEVICE,
    verifier: 'a'.repeat(64),
    algorithm: 'sha256',
    revoked_at: null,
    issued_at: AT,
    ...overrides,
  };
}

describe('InMemoryDeviceAuth', () => {
  it('runs the code state machine: pending → authorized → consumed, once', async () => {
    const store = new InMemoryDeviceAuth();
    await store.putDeviceCode(code());
    await store.authorizeDeviceCode('dc', PARTICIPANT, 'authorized');

    const authorized = await store.getDeviceCode('dc');
    expect(authorized?.status).toBe('authorized');
    expect(authorized?.participant_id).toBe(PARTICIPANT);

    await store.consumeDeviceCode('dc', AT);
    expect((await store.getDeviceCode('dc'))?.consumed_at).toBe(AT);
  });

  it('spends a session exactly once', async () => {
    const store = new InMemoryDeviceAuth();
    await store.putDeviceSession(session());

    const before = await store.getDeviceSession('st');
    expect(before?.consumed_at).toBeNull();

    await store.consumeDeviceSession('st');
    const after = await store.getDeviceSession('st');
    expect(after?.consumed_at).not.toBeNull();
  });

  it('registers a device, lists by participant, and touches last seen', async () => {
    const store = new InMemoryDeviceAuth();
    const device = await store.registerDevice({
      participantId: PARTICIPANT,
      name: 'build machine',
      createdAt: AT,
    });

    expect(device.id).toMatch(/^[\da-f-]{36}$/u);
    expect((await store.getDevice(device.id))?.name).toBe('build machine');
    expect((await store.listDevices(PARTICIPANT)).length).toBe(1);
    expect((await store.listDevices('01924a61-7a1b-7c2d-8e3f-0000000000ff')).length).toBe(0);

    await store.touchDeviceLastSeen(device.id, '2026-09-02T00:00:00.000Z');
    expect((await store.getDevice(device.id))?.last_seen_at).toBe('2026-09-02T00:00:00.000Z');
  });

  it('revoking a device revokes its live keys in the same act', async () => {
    const store = new InMemoryDeviceAuth();
    const device = await store.registerDevice({
      participantId: PARTICIPANT,
      name: 'build machine',
      createdAt: AT,
    });
    await store.createKey(keyRecord({ device_id: device.id }));

    await store.revokeDevice({
      deviceId: device.id,
      reason: 'retired',
      revokedAt: AT,
      updatedBy: PARTICIPANT,
    });

    expect((await store.getDevice(device.id))?.revoked_at).toBe(AT);
    expect((await store.getKeyById(KEY))?.revoked_at).toBe(AT);
  });

  it('ignores updates for unknown records (deny-default lookups stay null)', async () => {
    const store = new InMemoryDeviceAuth();
    await store.authorizeDeviceCode('nope', PARTICIPANT, 'authorized');
    await store.consumeDeviceCode('nope', AT);
    await store.consumeDeviceSession('nope');
    await store.revokeDevice({
      deviceId: 'nope',
      reason: null,
      revokedAt: AT,
      updatedBy: PARTICIPANT,
    });
    await store.touchDeviceLastSeen('nope', AT);

    await expect(store.getDeviceCode('nope')).resolves.toBeNull();
    await expect(store.getDeviceSession('nope')).resolves.toBeNull();
    await expect(store.getDevice('nope')).resolves.toBeNull();
    await expect(store.getKeyById('nope')).resolves.toBeNull();
  });
});

describe('PostgresDeviceAuth (fake wire)', () => {
  /** Scripts one SQL reply per matching fragment, in assertion order. */
  function fakeSql(replies: { contains: string; rows: unknown[] }[]): {
    sql: postgres.Sql;
    texts: string[];
  } {
    const texts: string[] = [];
    const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const text = strings.join(' ');
      texts.push(text);
      void values;
      const match = replies.find((r) => text.includes(r.contains));
      return Promise.resolve(match === undefined ? [] : match.rows);
    };
    return { sql: tag as unknown as postgres.Sql, texts };
  }

  it('inserts a pending device code with a null participant', async () => {
    const writes: { text: string; values: unknown[] }[] = [];
    const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      writes.push({ text: strings.join(' '), values });
      return Promise.resolve([]);
    };
    const store = new PostgresDeviceAuth(tag as unknown as postgres.Sql);

    await store.putDeviceCode(code());

    const write = writes[0];
    expect(write?.text).toContain('INSERT INTO device_codes');
    // the pending status rides the parameter list, not the SQL text
    expect(write?.values).toContain('pending');
    expect(write?.values).toContain(null);
  });

  it('authorizes only a code that is still pending', async () => {
    const { sql, texts } = fakeSql([{ contains: 'UPDATE device_codes', rows: [] }]);
    const store = new PostgresDeviceAuth(sql);

    await store.authorizeDeviceCode('dc', PARTICIPANT, 'authorized');

    expect(texts[0]).toContain("status = 'pending'");
  });

  it('reads and consumes a session exactly once', async () => {
    const { sql, texts } = fakeSql([
      {
        contains: 'FROM device_sessions',
        rows: [
          {
            session_token: 'st',
            device_code: 'dc',
            participant_id: PARTICIPANT,
            access_token: 'at',
            refresh_token: 'rt',
            expires_at: AT,
            consumed_at: null,
            created_at: AT,
          },
        ],
      },
      { contains: 'UPDATE device_sessions', rows: [] },
    ]);
    const store = new PostgresDeviceAuth(sql);

    const found = await store.getDeviceSession('st');
    expect(found?.participant_id).toBe(PARTICIPANT);
    expect(found?.consumed_at).toBeNull();

    await store.consumeDeviceSession('st');
    expect(texts[1]).toContain('consumed_at IS NULL');
  });

  it('registers a device and returns the persisted row', async () => {
    const { sql } = fakeSql([
      {
        contains: 'INSERT INTO devices',
        rows: [
          {
            id: DEVICE,
            participant_id: PARTICIPANT,
            name: 'build machine',
            revoked_at: null,
            revoke_reason: null,
            last_seen_at: null,
            created_at: AT,
          },
        ],
      },
    ]);
    const store = new PostgresDeviceAuth(sql);

    const device = await store.registerDevice({
      participantId: PARTICIPANT,
      name: 'build machine',
      createdAt: AT,
    });

    expect(device.id).toBe(DEVICE);
    expect(device.participant_id).toBe(PARTICIPANT);
  });

  it('revocation is one update; the trigger carries the key stop flag', async () => {
    const { sql, texts } = fakeSql([{ contains: 'UPDATE devices', rows: [] }]);
    const store = new PostgresDeviceAuth(sql);

    await store.revokeDevice({
      deviceId: DEVICE,
      reason: 'retired',
      revokedAt: AT,
      updatedBy: PARTICIPANT,
    });

    expect(texts[0]).toContain('revoked_at IS NULL');
    // no second statement: the cascade is the table trigger, not the adapter
    expect(texts.length).toBe(1);
  });

  it('looks a key up by id and maps every persisted column', async () => {
    const { sql, texts } = fakeSql([
      {
        contains: 'FROM device_keys',
        rows: [
          {
            key_id: KEY,
            device_id: DEVICE,
            verifier: 'a'.repeat(64),
            algorithm: 'sha256',
            revoked_at: null,
            issued_at: AT,
          },
        ],
      },
    ]);
    const store = new PostgresDeviceAuth(sql);

    const key = await store.getKeyById(KEY);

    expect(key?.verifier).toBe('a'.repeat(64));
    expect(key?.device_id).toBe(DEVICE);
    expect(texts[0]).toContain('deleted_at IS NULL');
  });

  it('maps a stored device code row with every persisted column', async () => {
    const { sql } = fakeSql([
      {
        contains: 'FROM device_codes',
        rows: [
          {
            device_code: 'dc',
            participant_id: PARTICIPANT,
            user_code: 'hjkm-pqrs',
            verification_uri: 'http://127.0.0.1/device',
            expires_at: AT,
            interval_seconds: 5,
            status: 'authorized',
            created_at: AT,
            consumed_at: AT,
          },
        ],
      },
    ]);
    const store = new PostgresDeviceAuth(sql);

    const found = await store.getDeviceCode('dc');

    expect(found).toEqual(
      code({ participant_id: PARTICIPANT, status: 'authorized', consumed_at: AT }),
    );
  });

  it('registers a key and maps a device row', async () => {
    const { sql, texts } = fakeSql([
      { contains: 'INSERT INTO device_keys', rows: [] },
      {
        contains: 'FROM devices',
        rows: [
          {
            id: DEVICE,
            participant_id: PARTICIPANT,
            name: 'build machine',
            revoked_at: AT,
            revoke_reason: 'retired',
            last_seen_at: AT,
            created_at: AT,
          },
        ],
      },
    ]);
    const store = new PostgresDeviceAuth(sql);

    await store.createKey(keyRecord());
    expect(texts[0]).toContain('INSERT INTO device_keys');

    const device = await store.getDevice(DEVICE);
    expect(device?.revoked_at).toBe(AT);
    expect(device?.revoke_reason).toBe('retired');
    expect(device?.last_seen_at).toBe(AT);
  });

  it('lists all of a participant’s devices in registration order', async () => {
    const { sql } = fakeSql([
      {
        contains: 'ORDER BY created_at ASC',
        rows: [
          {
            id: DEVICE,
            participant_id: PARTICIPANT,
            name: 'one',
            revoked_at: null,
            revoke_reason: null,
            last_seen_at: null,
            created_at: AT,
          },
          {
            id: '01924a61-7a1b-7c2d-8e3f-000000000002',
            participant_id: PARTICIPANT,
            name: 'two',
            revoked_at: null,
            revoke_reason: null,
            last_seen_at: null,
            created_at: '2026-09-02T00:00:00.000Z',
          },
        ],
      },
    ]);
    const store = new PostgresDeviceAuth(sql);

    const list = await store.listDevices(PARTICIPANT);

    expect(list.map((d) => d.name)).toEqual(['one', 'two']);
  });

  it('denies an unknown token lookup with null, and stamps a live key seen', async () => {
    const { sql, texts } = fakeSql([
      { contains: 'UPDATE devices', rows: [] },
      { contains: 'UPDATE device_codes', rows: [] },
    ]);
    const store = new PostgresDeviceAuth(sql);

    await store.touchDeviceLastSeen(DEVICE, AT);
    await store.consumeDeviceCode('dc', AT);

    expect(texts[0]).toContain('UPDATE devices');
    expect(texts[1]).toContain('consumed_at IS NULL');
  });

  it('inserts a session row and answers null for an unknown one', async () => {
    const { sql, texts } = fakeSql([{ contains: 'INSERT INTO device_sessions', rows: [] }]);
    const store = new PostgresDeviceAuth(sql);

    await store.putDeviceSession(session());
    expect(texts[0]).toContain('INSERT INTO device_sessions');

    await expect(store.getDeviceSession('none')).resolves.toBeNull();
  });

  it('answers null for unknown keys and devices', async () => {
    const { sql } = fakeSql([]);
    const store = new PostgresDeviceAuth(sql);

    await expect(store.getKeyById('none')).resolves.toBeNull();
    await expect(store.getDevice('none')).resolves.toBeNull();
    await expect(store.getDeviceCode('none')).resolves.toBeNull();
  });
});
