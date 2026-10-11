import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@navis/domain';
import {
  createConnection,
  runMigrations,
  PostgresDeviceAuth,
  createDeviceAuthTransaction,
} from '@navis/infrastructure';
import {
  requestDeviceFlow,
  pollDeviceToken,
  registerDevice,
  revokeDevice,
  authenticateKey,
} from '../src/auth/device-auth-flow.js';
const configured = process.env['DATABASE_URL']?.trim();
const databaseUrl = configured === '' ? undefined : configured;
describe.runIf(databaseUrl !== undefined)('one-shot device authorization transactions', () => {
  const sql = databaseUrl === undefined ? undefined : createConnection(databaseUrl);
  beforeAll(async () => {
    if (sql) await runMigrations(sql);
  });
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 0 });
  });
  it('exchanges a code and registers its session once under concurrent requests', async () => {
    if (!sql) throw new Error('database required');
    const store = new PostgresDeviceAuth(sql);
    const participant = uuidv7();
    const deps = {
      store,
      now: () => new Date().toISOString(),
      verificationBaseUrl: 'https://localhost.invalid',
      transact: createDeviceAuthTransaction(sql),
    };
    const code = await requestDeviceFlow(deps);
    await store.authorizeDeviceCode(code.device_code, participant, 'authorized');
    const polls = await Promise.all(
      Array.from({ length: 8 }, () => pollDeviceToken(deps, code.device_code)),
    );
    const authorized = polls.filter((reply) => reply?.outcome === 'authorized');
    expect(authorized).toHaveLength(1);
    const token = authorized[0];
    if (token?.outcome !== 'authorized') throw new Error('token missing');
    const devices = await Promise.all(
      Array.from({ length: 8 }, () => registerDevice(deps, token.access_token, 'one-shot device')),
    );
    const issued = devices.filter((device) => device !== null);
    expect(issued).toHaveLength(1);
    expect(await store.listDevices(participant)).toHaveLength(1);
    const device = issued[0];
    if (!device) throw new Error('device missing');
    await revokeDevice(deps, device.device_id, 'retired', participant);
    await expect(
      authenticateKey(deps, `Bearer ${device.key_id}.${device.key_secret}`),
    ).resolves.toEqual({ outcome: 'device_revoked' });
  });
});
