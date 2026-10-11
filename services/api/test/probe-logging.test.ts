import { afterEach, expect, it } from 'vitest';
import { createApiServer, type ApiServer } from '../src/platform/server.js';
import { loadApiConfig } from '../src/platform/config.js';

const servers: ApiServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});
async function fixture(level: 'info' | 'debug', ready = () => Promise.resolve()) {
  const logs: Record<string, unknown>[] = [];
  const server = createApiServer(
    { ...loadApiConfig({}), log_level: level },
    {
      write(line) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
    [
      {
        method: 'GET',
        path: '/business',
        requiresBody: false,
        handle: () => Promise.resolve({ ok: true }),
      },
    ],
    ready,
  );
  servers.push(server);
  const base = `http://127.0.0.1:${String(await server.listen(0, '127.0.0.1'))}`;
  return { logs, base };
}
it('suppresses successful probe access logs at info while retaining business traffic', async () => {
  const { logs, base } = await fixture('info');
  for (const path of ['/readyz', '/healthz', '/readyz?probe=1']) {
    const response = await fetch(base + path);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  }
  expect(logs).toEqual([]);
  await (await fetch(base + '/business')).arrayBuffer();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ level: 'info', path: '/business', status: 200 });
});
it('retains successful probe diagnostics when debug logging is selected', async () => {
  const { logs, base } = await fixture('debug');
  await (await fetch(base + '/readyz')).arrayBuffer();
  expect(logs[0]).toMatchObject({ level: 'debug', path: '/readyz', status: 200 });
});
it('keeps failed probes visible and correlated at the default level', async () => {
  const { logs, base } = await fixture('info', () =>
    Promise.reject(new Error('private database detail')),
  );
  const response = await fetch(base + '/readyz');
  const problem = (await response.json()) as { request_id: string };
  expect(response.status).toBe(503);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    level: 'error',
    path: '/readyz',
    status: 503,
    request_id: problem.request_id,
  });
  expect(JSON.stringify(logs)).not.toContain('private database detail');
});
