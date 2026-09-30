import { describe, expect, it } from 'vitest';

import { InMemoryDeviceAuth } from '@navis/infrastructure';

import {
  authenticateKey,
  listDevices,
  pollDeviceToken,
  registerDevice,
  requestDeviceFlow,
  revokeDevice,
} from '../src/auth/device-auth-flow.js';

/**
 * Device-auth use cases against the in-memory adapter: the port semantics
 * the wire tests cannot reach cheaply — expiry edges, the one-shot session
 * spend, the denied-code answer, and the constant-shape authentication
 * denials. The wire suite proves the same behavior end-to-end.
 */

const NOW = '2026-09-01T00:00:00.000Z';
const LATER = '2026-09-02T00:00:00.000Z';
const PARTICIPANT = '01924a61-7a1b-7c2d-8e3f-0000000000b1';

function fixture(now: () => string = () => NOW) {
  const store = new InMemoryDeviceAuth();
  return { store, deps: { store, now, verificationBaseUrl: 'http://127.0.0.1/device' } };
}

describe('requestDeviceFlow', () => {
  it('issues a pending device code with the RFC 8628 response fields', async () => {
    const fx = fixture();

    const response = await requestDeviceFlow(fx.deps);

    expect(response.device_code.length).toBeGreaterThanOrEqual(16);
    expect(response.user_code).toMatch(/^[bcdfghjkmnpqrstvwxyz]{4}-[bcdfghjkmnpqrstvwxyz]{4}$/u);
    expect(response.verification_uri).toBe('http://127.0.0.1/device');
    expect(response.expires_in).toBe(900);
    expect(response.interval).toBe(5);

    const stored = await fx.store.getDeviceCode(response.device_code);
    expect(stored?.status).toBe('pending');
    expect(stored?.participant_id).toBeNull();
  });
});

describe('pollDeviceToken', () => {
  it('answers pending for a live, unauthorized code', async () => {
    const fx = fixture();
    const code = await requestDeviceFlow(fx.deps);

    const poll = await pollDeviceToken(fx.deps, code.device_code);

    expect(poll?.outcome).toBe('pending');
    if (poll?.outcome === 'pending') expect(poll.interval_seconds).toBe(5);
  });

  it('answers expired for a code past its lifetime', async () => {
    const fx = fixture();
    const code = await requestDeviceFlow(fx.deps);
    // the same clock reads a moment past the ttl at poll time
    const afterExpiry = { ...fx.deps, now: () => '2026-09-01T00:16:01.000Z' };

    const poll = await pollDeviceToken(afterExpiry, code.device_code);

    expect(poll?.outcome).toBe('expired');
  });

  it('answers denied after the owner refused', async () => {
    const fx = fixture();
    const code = await requestDeviceFlow(fx.deps);
    await fx.store.authorizeDeviceCode(code.device_code, PARTICIPANT, 'denied');

    const poll = await pollDeviceToken(fx.deps, code.device_code);

    expect(poll?.outcome).toBe('denied');
  });

  it('issues a one-shot session on authorization and rejects a replay', async () => {
    const fx = fixture();
    const code = await requestDeviceFlow(fx.deps);
    await fx.store.authorizeDeviceCode(code.device_code, PARTICIPANT, 'authorized');

    const first = await pollDeviceToken(fx.deps, code.device_code);
    expect(first?.outcome).toBe('authorized');
    if (first?.outcome === 'authorized') {
      expect(first.participant_id).toBe(PARTICIPANT);
      expect(first.access_token.length).toBeGreaterThan(0);
      expect(first.refresh_token.length).toBeGreaterThan(0);
    }

    // the code is spent; a replay mints nothing
    const replay = await pollDeviceToken(fx.deps, code.device_code);
    expect(replay?.outcome).toBe('expired');
  });

  it('answers expired for a stored expired code', async () => {
    const fx = fixture();
    const code = await requestDeviceFlow(fx.deps);
    const stored = await fx.store.getDeviceCode(code.device_code);
    if (stored === null) throw new Error('seeded code not found');
    await fx.store.putDeviceCode({ ...stored, status: 'expired' });

    const poll = await pollDeviceToken(fx.deps, code.device_code);

    expect(poll?.outcome).toBe('expired');
  });

  it('answers null for an unknown code without guessing its state', async () => {
    const fx = fixture();

    await expect(pollDeviceToken(fx.deps, 'unknown-code')).resolves.toBeNull();
  });

  it('treats an authorized code without a participant as denied, never authorized', async () => {
    const fx = fixture();
    const code = await requestDeviceFlow(fx.deps);
    // defensive: the port contract says participant is resolved at authorize;
    // a code reaching poll without one is a denial, not a crash
    await fx.store.authorizeDeviceCode(code.device_code, PARTICIPANT, 'authorized');
    const stored = await fx.store.getDeviceCode(code.device_code);
    if (stored === null) throw new Error('seeded code not found');
    await fx.store.putDeviceCode({ ...stored, participant_id: null });

    const poll = await pollDeviceToken(fx.deps, code.device_code);

    expect(poll?.outcome).toBe('denied');
  });
});

describe('registerDevice', () => {
  it('issues a key once: the session, once spent, registers nothing again', async () => {
    const fx = fixture();
    const code = await requestDeviceFlow(fx.deps);
    await fx.store.authorizeDeviceCode(code.device_code, PARTICIPANT, 'authorized');
    const poll = await pollDeviceToken(fx.deps, code.device_code);
    if (poll?.outcome !== 'authorized') throw new Error('expected authorization');
    const accessToken = poll.access_token;

    const registered = await registerDevice(fx.deps, accessToken, 'build machine');
    expect(registered).not.toBeNull();
    if (registered === null) throw new Error('expected a device');
    expect(registered.key_secret.length).toBeGreaterThanOrEqual(32);

    // the session is consumed with the issuance: no second device with it
    const replay = await registerDevice(fx.deps, accessToken, 'other machine');
    expect(replay).toBeNull();
  });

  it('refuses unknown or expired sessions', async () => {
    const fx = fixture();

    await expect(registerDevice(fx.deps, 'no-such-token', 'x')).resolves.toBeNull();

    const code = await requestDeviceFlow(fx.deps);
    await fx.store.authorizeDeviceCode(code.device_code, PARTICIPANT, 'authorized');
    const poll = await pollDeviceToken(fx.deps, code.device_code);
    if (poll?.outcome !== 'authorized') throw new Error('expected authorization');
    const stale = { ...fx.deps, now: () => '2026-09-01T02:00:00.000Z' };
    await expect(registerDevice(stale, poll.access_token, 'x')).resolves.toBeNull();
  });
});

describe('revokeDevice + authenticateKey', () => {
  async function issueKey(fx: ReturnType<typeof fixture>) {
    const code = await requestDeviceFlow(fx.deps);
    await fx.store.authorizeDeviceCode(code.device_code, PARTICIPANT, 'authorized');
    const poll = await pollDeviceToken(fx.deps, code.device_code);
    if (poll?.outcome !== 'authorized') throw new Error('expected authorization');
    const device = await registerDevice(fx.deps, poll.access_token, 'build machine');
    if (device === null) throw new Error('expected a device');
    return device;
  }

  it('authenticates a live key with the bound participant id', async () => {
    const fx = fixture();
    const device = await issueKey(fx);

    const auth = await authenticateKey(fx.deps, `Bearer ${device.key_id}.${device.key_secret}`);

    expect(auth).toEqual({
      outcome: 'authenticated',
      participant_id: PARTICIPANT,
      device_id: device.device_id,
    });
    // authentication is observable: the device last_seen advances
    const stored = await fx.store.getDevice(device.device_id);
    expect(stored?.last_seen_at).toBe(NOW);
  });

  it('denies a revoked key immediately, before any read', async () => {
    const fx = fixture();
    const device = await issueKey(fx);
    await revokeDevice(fx.deps, device.device_id, 'retired', PARTICIPANT);

    const auth = await authenticateKey(fx.deps, `Bearer ${device.key_id}.${device.key_secret}`);

    expect(auth).toEqual({ outcome: 'device_revoked' });
  });

  it('denies a wrong secret with the same token as an unknown key', async () => {
    const fx = fixture();
    const device = await issueKey(fx);

    const wrongSecret = await authenticateKey(fx.deps, `Bearer ${device.key_id}.${'x'.repeat(43)}`);
    const unknownId = await authenticateKey(
      fx.deps,
      `Bearer 01924a61-7a1b-7c2d-8e3f-000000009999.${'x'.repeat(43)}`,
    );

    expect(wrongSecret).toEqual({ outcome: 'key_invalid' });
    expect(unknownId).toEqual({ outcome: 'key_invalid' });
    // the side-channel constraint: both denials must look identical
    expect(wrongSecret).toEqual(unknownId);
  });

  it('denies a malformed header with the same key_invalid token', async () => {
    const fx = fixture();

    await expect(authenticateKey(fx.deps, 'not-a-bearer')).resolves.toEqual({
      outcome: 'key_invalid',
    });
    await expect(authenticateKey(fx.deps, 'Bearer onlyonepart')).resolves.toEqual({
      outcome: 'key_invalid',
    });
  });

  it('denies when the device behind a live key has gone missing', async () => {
    const fx = fixture();
    const device = await issueKey(fx);
    // the device row is dropped out-of-band: deny-without-detail
    await fx.store.revokeDevice({
      deviceId: device.device_id,
      reason: null,
      revokedAt: LATER,
      updatedBy: PARTICIPANT,
    });

    const auth = await authenticateKey(fx.deps, `Bearer ${device.key_id}.${device.key_secret}`);

    expect(auth).toEqual({ outcome: 'device_revoked' });
  });
});

describe('listDevices', () => {
  it('returns only the caller’s devices, in registration order', async () => {
    const fx = fixture();
    const first = await registerDeviceHelper(fx, 'build machine one');
    const second = await registerDeviceHelper(fx, 'build machine two');

    const devices = await listDevices(fx.deps, PARTICIPANT);

    expect(devices.map((d) => d.id)).toEqual([first, second]);
    expect(devices.map((d) => d.name)).toEqual(['build machine one', 'build machine two']);
  });

  it('returns an empty list for a participant with no devices', async () => {
    const fx = fixture();

    await expect(listDevices(fx.deps, '01924a61-7a1b-7c2d-8e3f-0000000000ff')).resolves.toEqual([]);
  });
});

async function registerDeviceHelper(fx: ReturnType<typeof fixture>, name: string): Promise<string> {
  const code = await requestDeviceFlow(fx.deps);
  await fx.store.authorizeDeviceCode(code.device_code, PARTICIPANT, 'authorized');
  const poll = await pollDeviceToken(fx.deps, code.device_code);
  if (poll?.outcome !== 'authorized') throw new Error('expected authorization');
  const device = await registerDevice(fx.deps, poll.access_token, name);
  if (device === null) throw new Error('expected a device');
  return device.device_id;
}
