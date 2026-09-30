import { request } from 'node:http';

import { uuidv7 } from '@navis/domain';
import { canonicalWorkEventSchemaVersion, ingestContractSchemaVersion } from '@navis/contracts';

import { afterEach, describe, expect, it } from 'vitest';

import {
  InMemoryDeviceAuth,
  InMemoryEventStore,
  InMemoryProjectDirectory,
} from '@navis/infrastructure';

import { loadApiConfig } from '../src/platform/config.js';
import { withDeviceAuth } from '../src/auth/middleware.js';
import { deviceAuthRoutes } from '../src/auth/device-auth-route.js';
import { ingestRoute } from '../src/ingest/route.js';
import {
  getProjectStateRoute,
  loadContextRoute,
  searchProjectsRoute,
} from '../src/query/routes.js';
import { createApiServer, type ApiServer } from '../src/platform/server.js';
import type { LogSink } from '../src/platform/logging.js';

/**
 * Authorization middleware at the wire (spec: authentication establishes
 * device identity; authorization is membership). The cross-scope cases are
 * negative proofs: a device whose participant is not a member is denied
 * with the authorization token and the ledger never moves — these are the
 * isolation tests standard 04 demands, not success stories.
 */

const NOW = '2026-09-01T00:00:00.000Z';
const PROJECT_A = '01924a61-7a1b-7c2d-8e3f-000000000001';
const PROJECT_B = '01924a61-7a1b-7c2d-8e3f-000000000002';
const PARTICIPANT_A = '01924a61-7a1b-7c2d-8e3f-0000000000b1';
const PARTICIPANT_B = '01924a61-7a1b-7c2d-8e3f-0000000000b2';

interface Response {
  readonly status: number;
  readonly body: unknown;
}

interface Fixture {
  readonly store: InMemoryDeviceAuth;
  readonly eventStore: InMemoryEventStore;
  readonly acquireKey: (participantId: string) => Promise<{ header: string; deviceId: string }>;
  readonly get: (path: string, authorization?: string) => Promise<Response>;
  readonly post: (path: string, body: unknown, authorization?: string) => Promise<Response>;
  readonly logs: string[];
}

const started: ApiServer[] = [];

/** The device-auth chain plus two protected routes, wrapped in the gate. */
function openRoutes(memberParticipantId: string | null): Fixture {
  const logs: string[] = [];
  const sink: LogSink = {
    write(line) {
      logs.push(line);
    },
  };
  const store = new InMemoryDeviceAuth();
  const eventStore = new InMemoryEventStore();
  const directory = new InMemoryProjectDirectory();
  directory.register({
    project_id: PROJECT_A,
    title: 'merchant a',
    status: 'active',
    state_version: 0,
  });
  directory.register({
    project_id: PROJECT_B,
    title: 'merchant b',
    status: 'active',
    state_version: 0,
  });
  if (memberParticipantId !== null) {
    directory.grant(memberParticipantId, PROJECT_A);
  }

  const deviceFlow = { store, now: () => NOW, verificationBaseUrl: 'http://127.0.0.1/device' };
  // the wrapper verifies the key; the sink binds the verified identity into
  // every wrapped route's participant dep, exactly like the composition root
  let currentParticipant: string | null = null;
  const identitySink = (identity: { participantId: string; deviceId: string }): void => {
    currentParticipant = identity.participantId;
  };
  const queryDeps = {
    eventStore,
    projectDirectory: directory,
    participantId: () => currentParticipant,
  };
  const routes = [
    ...deviceAuthRoutes({ deviceFlow }),
    withDeviceAuth({ deviceFlow, projectDirectory: directory }, getProjectStateRoute(queryDeps), {
      identitySink,
    }),
    withDeviceAuth({ deviceFlow, projectDirectory: directory }, loadContextRoute(queryDeps), {
      identitySink,
    }),
    withDeviceAuth({ deviceFlow, projectDirectory: directory }, searchProjectsRoute(queryDeps), {
      identitySink,
    }),
    withDeviceAuth(
      { deviceFlow, projectDirectory: directory },
      ingestRoute({ eventStore, verifyPayloadHash: false, now: () => NOW }),
      {
        identitySink,
        extractProjectIds: (input) => {
          // every event envelope in the batch names its project; the gate is per event
          const body = input as { events?: readonly unknown[] } | undefined;
          if (body?.events === undefined) return [];
          const ids: string[] = [];
          for (const entry of body.events) {
            if (typeof entry !== 'object' || entry === null) continue;
            const event = (entry as { event?: unknown }).event;
            if (typeof event === 'object' && event !== null) {
              const projectId = (event as { project_id?: unknown }).project_id;
              if (typeof projectId === 'string') ids.push(projectId);
            }
          }
          return ids;
        },
      },
    ),
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

  const acquireKey = async (participant: string): Promise<{ header: string; deviceId: string }> => {
    const code = (await (
      await call('POST', '/api/device/codes', {})
    ).body) as Record<string, unknown>;
    const codeData = code['data'] as Record<string, unknown>;
    const deviceCode = codeData['device_code'] as string;
    await store.authorizeDeviceCode(deviceCode, participant, 'authorized');
    const token = (
      await call('POST', '/api/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
      })
    ).body as Record<string, unknown>;
    const accessToken = (token['data'] as Record<string, unknown>)['access_token'] as string;
    const registered = (
      await call('POST', '/api/devices', { name: `${participant} device` }, `Bearer ${accessToken}`)
    ).body as Record<string, unknown>;
    const data = registered['data'] as Record<string, unknown>;
    return {
      header: `Bearer ${data['key_id'] as string}.${data['key_secret'] as string}`,
      deviceId: data['device_id'] as string,
    };
  };

  return {
    store,
    eventStore,
    acquireKey,
    get: (path, authorization) => call('GET', path, undefined, authorization),
    post: (path, body, authorization) => call('POST', path, body, authorization),
    logs,
  };
}

function dataOf(body: unknown): Record<string, unknown> {
  const envelope = body as { data?: Record<string, unknown> | null } | undefined;
  return envelope?.data ?? {};
}

afterEach(async () => {
  while (started.length > 0) {
    const server = started.pop();
    if (server !== undefined) await server.close();
  }
});

describe('device authentication at the gate', () => {
  it('rejects a request without a key, with the constant key-invalid token', async () => {
    const fx = openRoutes(PARTICIPANT_A);
    const res = await fx.get(`/api/projects/${PROJECT_A}/state`);

    expect(res.status).toBe(401);
    expect((res.body as Record<string, unknown>)['detail']).toBe('device-auth/key-invalid');
  });

  it('rejects a revoked key with the device-revoked token', async () => {
    const fx = openRoutes(PARTICIPANT_A);
    const { header } = await fx.acquireKey(PARTICIPANT_A);
    // the underlying key id is part of the header: revoke through the store
    const keyId = header.slice('Bearer '.length).split('.')[0];
    if (keyId === undefined) throw new Error('expected a key id');
    const key = await fx.store.getKeyById(keyId);
    if (key === null) throw new Error('expected a stored key');
    await fx.store.revokeDevice({
      deviceId: key.device_id,
      reason: 'handover',
      revokedAt: NOW,
      updatedBy: PARTICIPANT_A,
    });

    const res = await fx.get(`/api/projects/${PROJECT_A}/state`, header);

    expect(res.status).toBe(401);
    expect((res.body as Record<string, unknown>)['detail']).toBe('device-auth/device-revoked');
  });

  it('rejects a wrong secret with the same token as an unknown key', async () => {
    const fx = openRoutes(PARTICIPANT_A);
    const { header: key } = await fx.acquireKey(PARTICIPANT_A);
    const keyId = key.slice('Bearer '.length).split('.')[0];
    if (keyId === undefined) throw new Error('expected a key id');
    const wrong = `Bearer ${keyId}.${'x'.repeat(43)}`;

    const res1 = await fx.get(`/api/projects/${PROJECT_A}/state`, wrong);
    const res2 = await fx.get(`/api/projects/${PROJECT_A}/state`, 'Bearer does-not-exist.xyz');

    expect(res1.status).toBe(401);
    expect(res2.status).toBe(401);
    expect((res1.body as Record<string, unknown>)['detail']).toBe('device-auth/key-invalid');
    expect((res2.body as Record<string, unknown>)['detail']).toBe('device-auth/key-invalid');
    expect((res1.body as Record<string, unknown>)['code']).toBe('UNAUTHORIZED');
  });
});

describe('membership gates the query surface', () => {
  it('a member sees their project state through the gate', async () => {
    const fx = openRoutes(PARTICIPANT_A);
    const { header } = await fx.acquireKey(PARTICIPANT_A);

    const res = await fx.get(`/api/projects/${PROJECT_A}/state`, header);

    expect(res.status).toBe(200);
    expect(dataOf(res.body)).toHaveProperty('project_id', PROJECT_A);
  });

  it('a non-member device is denied at the gate, with no query side effects', async () => {
    const fx = openRoutes(PARTICIPANT_A);
    const { header } = await fx.acquireKey(PARTICIPANT_B);

    const res = await fx.get(`/api/projects/${PROJECT_A}/state`, header);

    expect(res.status).toBe(403);
    expect((res.body as Record<string, unknown>)['detail']).toBe(
      'device-auth/authorization-denied',
    );
  });

  it('search only surfaces projects the participant is a member of', async () => {
    const fx = openRoutes(PARTICIPANT_A);
    const { header } = await fx.acquireKey(PARTICIPANT_A);

    const mine = dataOf((await fx.get('/api/projects?query=merchant&limit=10', header)).body);
    expect((mine['results'] as unknown[]).length).toBe(1);

    const other = await fx.get(
      '/api/projects?query=merchant&limit=10',
      (await fx.acquireKey(PARTICIPANT_B)).header,
    );
    expect((dataOf(other.body)['results'] as unknown[]).length).toBe(0);
  });
});

describe('membership gates ingest', () => {
  function ingestEvent(projectId: string): Record<string, unknown> {
    // the canonical work-event envelope; ingest wraps it per event
    return {
      schema_version: canonicalWorkEventSchemaVersion,
      occurred_at: NOW,
      project_id: projectId,
      source_runtime: 'test-runtime',
      source_session_id: 'session-1',
      raw_ref: 'file:///transcript.log',
      extractor_version: '0.1.0',
      confidence: 0.5,
      review_status: 'pending',
      event_type: 'work.started',
      payload: { work_id: uuidv7() },
    };
  }

  async function ingestBatch(
    fx: Fixture,
    projectId: string,
  ): Promise<{ header: string; body: Record<string, unknown> }> {
    const { header, deviceId } = await fx.acquireKey(
      projectId === PROJECT_A ? PARTICIPANT_A : PARTICIPANT_B,
    );
    return {
      header,
      body: {
        contract_version: ingestContractSchemaVersion,
        event_schema_version: canonicalWorkEventSchemaVersion,
        device_id: deviceId,
        events: [{ event_id: uuidv7(), event: ingestEvent(projectId) }],
      },
    };
  }

  it('a member device ingests into its project', async () => {
    const fx = openRoutes(PARTICIPANT_A);
    const { header, body } = await ingestBatch(fx, PROJECT_A);

    const res = await fx.post('/api/ingest', body, header);

    expect(res.status).toBe(200);
    expect((dataOf(res.body)['accepted'] as unknown[]).length).toBe(1);
  });

  it('a non-member device cannot ingest into a project it does not belong to', async () => {
    const fx = openRoutes(PARTICIPANT_A);
    const { header, body } = await ingestBatch(fx, PROJECT_B);

    // B owns nothing; the event names A's project — the gate fires before parse
    body['events'] = [{ event_id: uuidv7(), event: ingestEvent(PROJECT_A) }];
    const res = await fx.post('/api/ingest', body, header);

    expect(res.status).toBe(403);
    expect((res.body as Record<string, unknown>)['detail']).toBe(
      'device-auth/authorization-denied',
    );
    // no event appended: cross-scope isolation is the property, not the code
    const ledger = await fx.eventStore.loadEvents(PROJECT_A, 0);
    expect(ledger.length).toBe(0);
  });
});
