import { request } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { InMemoryDeviceAuth } from '@navis/infrastructure';

import { loadApiConfig } from '../src/platform/config.js';
import { deviceAuthRoutes } from '../src/auth/device-auth-route.js';
import { createApiServer, type ApiServer } from '../src/platform/server.js';
import type { LogSink } from '../src/platform/logging.js';

/**
 * Device-auth end-to-end: the RFC 8628 flow at the wire (spec: a valid key
 * is accepted, a revoked key stops immediately, a flow issues a key once).
 * The store is the in-memory adapter; the transport shape, the one-shot
 * session spend, and the never-logged invariant are what this suite pins.
 * The owner-side authorize action is driven straight on the port — the
 * browser surface for it belongs to a later change, not this route set.
 */

const NOW = '2026-09-01T00:00:00.000Z';
const PARTICIPANT = '01924a61-7a1b-7c2d-8e3f-0000000000b1';

interface Response {
  readonly status: number;
  readonly body: unknown;
}

interface Fixture {
  readonly store: InMemoryDeviceAuth;
  readonly post: (path: string, body: unknown, authorization?: string) => Promise<Response>;
  readonly get: (path: string, authorization?: string) => Promise<Response>;
  readonly del: (path: string, body: unknown, authorization?: string) => Promise<Response>;
  readonly logs: string[];
}

const started: ApiServer[] = [];

/** Opens a device-auth server with a logging sink the tests can inspect. */
function openRoutes(): Fixture {
  const logs: string[] = [];
  const sink: LogSink = {
    write(line) {
      logs.push(line);
    },
  };
  const store = new InMemoryDeviceAuth();
  const routes = [
    ...deviceAuthRoutes({
      deviceFlow: { store, now: () => NOW, verificationBaseUrl: 'http://127.0.0.1/device' },
    }),
  ];
  const server = createApiServer(loadApiConfig({}), sink, routes);
  started.push(server);
  let portCache: number | undefined;

  const call = (
    method: string,
    path: string,
    body: unknown,
    authorization?: string,
  ): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      (async () => {
        portCache ??= await server.listen(0, '127.0.0.1');
        const headers: Record<string, string> = { connection: 'close' };
        if (authorization !== undefined) headers['authorization'] = authorization;
        let payload: string | undefined;
        if (body !== undefined) {
          payload = JSON.stringify(body);
          headers['content-type'] = 'application/json';
          // node rejects a chunked DELETE before the handler runs: declare the length
          headers['content-length'] = String(Buffer.byteLength(payload));
        }
        const req = request(
          { host: '127.0.0.1', port: portCache, method, path, headers },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              resolve({
                status: res.statusCode ?? 0,
                body: text.length === 0 ? undefined : JSON.parse(text),
              });
            });
          },
        );
        req.on('error', reject);
        req.end(payload);
      })().catch(reject);
    });

  return {
    store,
    post: (path, body, authorization) => call('POST', path, body, authorization),
    get: (path, authorization) => call('GET', path, undefined, authorization),
    del: (path, body, authorization) => call('DELETE', path, body, authorization),
    logs,
  };
}

function dataOf(body: unknown): Record<string, unknown> {
  const envelope = body as { data?: Record<string, unknown> } | undefined;
  return envelope?.data ?? {};
}

afterEach(async () => {
  while (started.length > 0) {
    const server = started.pop();
    if (server !== undefined) await server.close();
  }
});

/** Completes the device flow and registers a device; returns the issued key. */
async function registerThroughFlow(
  fx: Fixture,
): Promise<{ keyId: string; deviceId: string; secret: string }> {
  const code = dataOf((await fx.post('/api/device/codes', {})).body);
  const deviceCode = code['device_code'] as string;
  // the owner authorizes in the browser; the port side is the same write
  await fx.store.authorizeDeviceCode(deviceCode, PARTICIPANT, 'authorized');

  const token = dataOf(
    (
      await fx.post('/api/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
      })
    ).body,
  );
  const accessToken = token['access_token'] as string;

  const regRes = await fx.post('/api/devices', { name: 'build machine' }, `Bearer ${accessToken}`);
  expect(regRes.status).toBe(200);
  const registered = dataOf(regRes.body);
  return {
    keyId: registered['key_id'] as string,
    deviceId: registered['device_id'] as string,
    secret: registered['key_secret'] as string,
  };
}

describe('POST /api/device/codes', () => {
  it('issues a device code with the poll contract fields', async () => {
    const fx = openRoutes();
    const res = await fx.post('/api/device/codes', {});

    expect(res.status).toBe(200);
    const data = dataOf(res.body);
    expect(typeof data['device_code']).toBe('string');
    expect(data['user_code']).toMatch(/^[bcdfghjkmnpqrstvwxyz]{4}-[bcdfghjkmnpqrstvwxyz]{4}$/u);
    expect(data['verification_uri']).toBe('http://127.0.0.1/device');
    expect(data['expires_in']).toBe(900);
    expect(data['interval']).toBe(5);
  });

  it('refuses an unsupported contract version with the supported range', async () => {
    const fx = openRoutes();
    const res = await fx.post('/api/device/codes', { contract_version: 999 });

    expect(res.status).toBe(400);
    const problem = res.body as Record<string, unknown>;
    expect(problem['code']).toBe('UNSUPPORTED_CONTRACT_VERSION');
    expect(problem['server_supported_contract_versions']).toEqual([1]);
  });
});

describe('POST /api/device/token', () => {
  it('answers a pending code with authorization_pending', async () => {
    const fx = openRoutes();
    const created = dataOf((await fx.post('/api/device/codes', {})).body);
    const res = await fx.post('/api/device/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: created['device_code'],
    });

    expect(res.status).toBe(200);
    expect(dataOf(res.body)['error']).toBe('authorization_pending');
    expect(dataOf(res.body)['interval']).toBe(5);
  });

  it('answers an unknown code with expired_token, never a guessable reason', async () => {
    const fx = openRoutes();
    const res = await fx.post('/api/device/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'unknown-code-long-enough-for-the-schema',
    });

    expect(res.status).toBe(200);
    expect(dataOf(res.body)['error']).toBe('expired_token');
  });

  it('answers denied after the owner refused the code', async () => {
    const fx = openRoutes();
    const code = dataOf((await fx.post('/api/device/codes', {})).body);
    await fx.store.authorizeDeviceCode(code['device_code'] as string, PARTICIPANT, 'denied');

    const res = dataOf(
      (
        await fx.post('/api/device/token', {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: code['device_code'],
        })
      ).body,
    );
    expect(res['error']).toBe('authorization_denied');
  });

  it('issues a one-shot session for an authorized code, and never a second', async () => {
    const fx = openRoutes();
    const code = dataOf((await fx.post('/api/device/codes', {})).body);
    const deviceCode = code['device_code'] as string;
    await fx.store.authorizeDeviceCode(deviceCode, PARTICIPANT, 'authorized');

    const first = dataOf(
      (
        await fx.post('/api/device/token', {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
        })
      ).body,
    );
    expect(first['token_type']).toBe('Bearer');
    expect(typeof first['access_token']).toBe('string');
    expect(first['participant_id']).toBe(PARTICIPANT);

    // the same device code is spent: a replay gets the expired token
    const replay = dataOf(
      (
        await fx.post('/api/device/token', {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
        })
      ).body,
    );
    expect(replay['error']).toBe('expired_token');
  });
});

describe('device registration and revocation', () => {
  it('registers a device and returns the key exactly once', async () => {
    const fx = openRoutes();
    const registered = await registerThroughFlow(fx);

    expect(registered.keyId).toMatch(/^[\da-f-]{36}$/u);
    expect(registered.deviceId).toMatch(/^[\da-f-]{36}$/u);
    expect(registered.secret.length).toBeGreaterThanOrEqual(32);

    // the issued secret never lands in any log line
    const leaked = fx.logs.find((line) => line.includes(registered.secret));
    expect(leaked).toBeUndefined();

    // the one-shot session is spent: the same token cannot register twice
    const code = dataOf((await fx.post('/api/device/codes', {})).body);
    const deviceCode = code['device_code'] as string;
    await fx.store.authorizeDeviceCode(deviceCode, PARTICIPANT, 'authorized');
    const second = dataOf(
      (
        await fx.post('/api/device/token', {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
        })
      ).body,
    );
    const usedToken = second['access_token'] as string;
    const ok = dataOf(
      (await fx.post('/api/devices', { name: 'second machine' }, `Bearer ${usedToken}`)).body,
    );
    expect(ok['device_id']).toMatch(/^[\da-f-]{36}$/u);
    const replayed = await fx.post('/api/devices', { name: 'again' }, `Bearer ${usedToken}`);
    expect(replayed.status).toBe(400);
  });

  it('authenticates a live key and denies it after revocation', async () => {
    const fx = openRoutes();
    const registered = await registerThroughFlow(fx);
    const header = `Bearer ${registered.keyId}.${registered.secret}`;

    // a live key lists the caller's devices
    const listed = dataOf((await fx.get('/api/devices', header)).body);
    const devices = listed['devices'] as Record<string, unknown>[];
    expect(devices.length).toBe(1);
    expect(devices[0]?.['device_id']).toBe(registered.deviceId);
    expect(devices[0]?.['name']).toBe('build machine');
    expect(devices[0]).not.toHaveProperty('key_secret');
    // revocation is immediate: the very next request with the key is denied
    const revoked = dataOf(
      (
        await fx.del(
          `/api/devices/${registered.deviceId}`,
          { device_id: registered.deviceId, reason: 'retired' },
          header,
        )
      ).body,
    );
    expect(revoked['revoked']).toBe(true);

    const after = dataOf((await fx.get('/api/devices', header)).body);
    expect(after['devices']).toEqual([]);
  });

  it('denies an unknown key without revealing whether the id existed', async () => {
    const fx = openRoutes();
    const listed = dataOf(
      (await fx.get('/api/devices', 'Bearer 01924a61-7a1b-7c2d-8e3f-000000009999.unknown')).body,
    );
    expect(listed['devices']).toEqual([]);
  });

  it('rejects a registration call that lacks a bearer token', async () => {
    const fx = openRoutes();
    const res = await fx.post('/api/devices', { name: 'build machine' });

    expect(res.status).toBe(400);
  });

  it('denies a revocation without a bearer token', async () => {
    const fx = openRoutes();
    const res = await fx.del('/api/devices/01924a61-7a1b-7c2d-8e3f-000000000001', {
      device_id: '01924a61-7a1b-7c2d-8e3f-000000000001',
    });

    expect(res.status).toBe(200);
    expect(dataOf(res.body)['revoked']).toBe(false);
  });

  it('denies a malformed authorization header', async () => {
    const fx = openRoutes();
    const listed = dataOf((await fx.get('/api/devices', 'not-a-bearer')).body);
    expect(listed['devices']).toEqual([]);

    const noHeader = dataOf((await fx.get('/api/devices')).body);
    expect(noHeader['devices']).toEqual([]);
  });
});
