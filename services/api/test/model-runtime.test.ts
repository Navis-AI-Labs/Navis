import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { uuidv7, EventStoreCapacityError } from '@navis/domain';
import { ProjectOperationError, AssistanceCapacityError } from '@navis/application';
import { createApiRuntime, type ApiRuntime } from '../src/platform/composition.js';
import { loadApiConfig } from '../src/platform/config.js';
import { createApiServer } from '../src/platform/server.js';
import { projectRoutes } from '../src/project/routes.js';
const configured = process.env['DATABASE_URL']?.trim();
const databaseUrl = configured === '' ? undefined : configured;
describe.runIf(databaseUrl !== undefined)('model runtime and dependency failures', () => {
  let runtime: ApiRuntime;
  let provider: Server;
  let remote: string;
  let header: string;
  let projectId: string;
  const logs: string[] = [];
  beforeAll(async () => {
    provider = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'a reviewable candidate' } }] }));
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider missing');
    runtime = await createApiRuntime(
      {
        ...loadApiConfig({
          DATABASE_URL: databaseUrl,
          NAVIS_MODEL_BASE_URL: `http://127.0.0.1:${String(address.port)}/v1`,
          NAVIS_MODEL_NAME: 'test-model',
          NAVIS_MODEL_API_KEY: 'test-provider-secret',
        }),
        port: 0,
      },
      { write: (line) => logs.push(line) },
    );
    if (runtime.provision === undefined) throw new Error('provisioning missing');
    const device = await runtime.provision('model API owner', 'human');
    header = `Bearer ${device.key_id}.${device.key_secret}`;
    remote = `http://127.0.0.1:${String(await runtime.listen())}`;
    projectId = uuidv7();
    await call('POST', '/api/projects', { project_id: projectId, title: 'model API project' });
  });
  afterAll(async () => {
    await runtime.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) =>
      provider.close(() => {
        resolve();
      }),
    );
  });
  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(remote + path, {
      method,
      headers: {
        authorization: header,
        'content-type': 'application/json',
        'idempotency-key': uuidv7(),
        connection: 'close',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as { data: Record<string, unknown>; code?: string },
    };
  }
  it('runs a durable job using the supervised worker and exposes its result', async () => {
    const created = await call('POST', `/api/projects/${projectId}/assistance`, {
      prompt: 'propose a fact',
      expected_version: 0,
    });
    expect(created.status).toBe(200);
    const id = String(created.body.data['job_id']);
    let result = await call('GET', `/api/projects/${projectId}/assistance/${id}`);
    for (let i = 0; i < 200 && result.body.data['status'] !== 'completed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      result = await call('GET', `/api/projects/${projectId}/assistance/${id}`);
    }
    expect(result.body.data['status']).toBe('completed');
    expect((await call('GET', '/readyz')).status).toBe(200);
    if (runtime.assistance === undefined) throw new Error('worker missing');
    vi.spyOn(runtime.assistance, 'tick').mockRejectedValueOnce(new Error('worker failed'));
    for (let i = 0; i < 150 && !logs.some((line) => line.includes('model worker failed')); i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(logs.some((line) => line.includes('model worker failed'))).toBe(true);
  });
  it('maps capacity and transient storage failures without exposing their details', async () => {
    if (runtime.assistance === undefined) throw new Error('assistance missing');
    vi.spyOn(runtime.assistance, 'submit').mockRejectedValueOnce(new AssistanceCapacityError());
    const limited = await call('POST', `/api/projects/${projectId}/assistance`, {
      prompt: 'budget exhausted',
      expected_version: 0,
    });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('MODEL_CAPACITY_EXCEEDED');
    if (runtime.projects === undefined) throw new Error('projects missing');
    vi.spyOn(runtime.projects, 'state').mockRejectedValueOnce(
      new ProjectOperationError('limit', 'internal budget details'),
    );
    expect((await call('GET', `/api/projects/${projectId}/snapshot`)).status).toBe(409);
    vi.spyOn(runtime.projects, 'state').mockRejectedValueOnce(new EventStoreCapacityError());
    expect((await call('GET', `/api/projects/${projectId}/snapshot`)).body.code).toBe(
      'LEDGER_CAPACITY_EXCEEDED',
    );
    vi.spyOn(runtime.projects, 'state').mockRejectedValueOnce(
      Object.assign(new Error('private query'), { code: '55P03' }),
    );
    const response = await call('GET', `/api/projects/${projectId}/snapshot`);
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('private query');
    const route = projectRoutes(runtime.projects, () => null)[0];
    if (route === undefined) throw new Error('route missing');
    await expect(
      route.handle(
        { project_id: uuidv7(), title: 'denied' },
        { request_id: uuidv7() },
        { 'idempotency-key': 'test' },
      ),
    ).rejects.toThrow('Forbidden');
  });
});
it('reports database unavailability as 503 while liveness remains available', async () => {
  const server = createApiServer(loadApiConfig({}), { write: () => undefined }, [], () =>
    Promise.reject(new Error('database unavailable')),
  );
  try {
    const port = await server.listen(0, '127.0.0.1');
    expect((await fetch(`http://127.0.0.1:${String(port)}/readyz`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status).toBe(200);
  } finally {
    await server.close();
  }
});
