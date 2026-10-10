import { afterEach, describe, expect, it, vi } from 'vitest';
import * as infrastructure from '@navis/infrastructure';
import { deviceCodeResponseSchema } from '@navis/contracts';

import { createApiRuntime, type ApiRuntime } from '../src/platform/composition.js';
import { loadApiConfig } from '../src/platform/config.js';

vi.mock('@navis/infrastructure', async (original) => ({
  ...(await original<typeof infrastructure>()),
  createConnection: vi.fn(),
  runMigrations: vi.fn(),
}));

const runtimes: ApiRuntime[] = [];
const logs: string[] = [];
const sink = {
  write: (line: string): void => {
    logs.push(line);
  },
};

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  vi.resetAllMocks();
  logs.length = 0;
});

function pooledConnection() {
  const end = vi.fn<() => Promise<void>>().mockResolvedValue();
  const sql = { end } as unknown as ReturnType<typeof infrastructure.createConnection>;
  vi.mocked(infrastructure.createConnection).mockReturnValue(sql);
  vi.mocked(infrastructure.runMigrations).mockResolvedValue();
  return { end, sql };
}

describe('API runtime composition', () => {
  it('starts the installed business routes without a database', async () => {
    const runtime = await createApiRuntime({ ...loadApiConfig({}), port: 0 }, sink);
    runtimes.push(runtime);
    const port = await runtime.listen();
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/device/codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(
      deviceCodeResponseSchema.parse((body as { data: unknown }).data).device_code.length,
    ).toBeGreaterThan(0);
    expect(infrastructure.createConnection).not.toHaveBeenCalled();
    expect(logs.length).toBeGreaterThan(0);
  });

  it('releases the pool when migrations fail', async () => {
    const { end } = pooledConnection();
    vi.mocked(infrastructure.runMigrations).mockRejectedValue(new Error('migration failure'));
    await expect(
      createApiRuntime(loadApiConfig({ DATABASE_URL: 'postgres://test.invalid/test' }), sink),
    ).rejects.toThrow('migration failure');
    expect(end).toHaveBeenCalledOnce();
  });

  it('drains HTTP and releases the pool once across repeated shutdowns', async () => {
    const { end } = pooledConnection();
    const runtime = await createApiRuntime(
      { ...loadApiConfig({ DATABASE_URL: 'postgres://test.invalid/test' }), port: 0 },
      sink,
    );
    runtimes.push(runtime);
    const port = await runtime.listen();
    expect(
      (
        await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
          headers: { connection: 'close' },
        })
      ).status,
    ).toBe(200);
    await Promise.all([runtime.close(), runtime.close()]);
    expect(end).toHaveBeenCalledOnce();
    await expect(fetch(`http://127.0.0.1:${String(port)}/healthz`)).rejects.toThrow();
  });

  it('closes its resources if the listening port is occupied', async () => {
    const first = await createApiRuntime({ ...loadApiConfig({}), port: 0 }, sink);
    runtimes.push(first);
    const port = await first.listen();
    const { end } = pooledConnection();
    const second = await createApiRuntime(
      { ...loadApiConfig({ DATABASE_URL: 'postgres://test.invalid/test' }), port },
      sink,
    );
    runtimes.push(second);
    await expect(second.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(end).toHaveBeenCalledOnce();
  });
});
