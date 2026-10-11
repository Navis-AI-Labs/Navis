import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@navis/domain';
import { NavisClient, readCredential, RemoteError } from '../src/remote/client.js';
import { declaredProjectId } from '../src/binding/toml.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
function fixture() {
  const dir = mkdtempSync('/tmp/nc-');
  cleanup.push(() => {
    rmSync(dir, { recursive: true, force: true });
    return Promise.resolve();
  });
  const file = path.join(dir, 'device.json');
  writeFileSync(
    file,
    JSON.stringify({
      participant_id: uuidv7(),
      participant_type: 'agent',
      device_id: uuidv7(),
      key_id: uuidv7(),
      key_secret: 'x'.repeat(32),
      issued_at: '2026-10-10T00:00:00.000Z',
    }),
    { mode: 0o600 },
  );
  return { dir, file };
}
async function endpoint(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, headers);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('listener missing');
  return `http://127.0.0.1:${String(address.port)}`;
}
describe('remote client and private configuration', () => {
  it('loads only a private, bounded, regular credential file', async () => {
    const f = fixture();
    expect((await readCredential(f.file)).participant_type).toBe('agent');
    chmodSync(f.file, 0o644);
    await expect(readCredential(f.file)).rejects.toThrow('private');
    chmodSync(f.file, 0o600);
    const link = path.join(f.dir, 'link');
    symlinkSync(f.file, link);
    await expect(readCredential(link)).rejects.toThrow('private');
    writeFileSync(f.file, 'x'.repeat(8193));
    await expect(readCredential(f.file)).rejects.toThrow('private');
  });
  it.each(
    [
      [403, JSON.stringify({ code: 'FORBIDDEN' })],
      [502, JSON.stringify({ detail: 'private upstream text' })],
      [204, ''],
      [200, JSON.stringify({ wrong: 'shape' })],
      [200, 'x'.repeat(16_777_217)],
    ].map(([status, body]) => ({ status: Number(status), body: String(body) })),
  )('rejects unsafe or failed responses: $status', async ({ status, body }) => {
    const f = fixture();
    const client = new NavisClient(await endpoint(status, body), f.file);
    await expect(client.request('GET', '/test')).rejects.toBeInstanceOf(RemoteError);
    await expect(client.request('GET', '/test')).rejects.not.toThrow('private upstream text');
  });
  it('returns a successful envelope and sends an idempotency key with body operations', async () => {
    const f = fixture();
    const client = new NavisClient(
      await endpoint(200, JSON.stringify({ data: { result: 'ok' } })),
      f.file,
    );
    await expect(client.request('POST', '/test', { value: 1 }, 'repeatable')).resolves.toEqual({
      result: 'ok',
    });
  });
  it('reads declarations without granting them authority and rejects invalid declarations', () => {
    const f = fixture();
    expect(() => declaredProjectId(f.dir)).toThrow('not found');
    writeFileSync(path.join(f.dir, 'navis.toml'), 'invalid');
    expect(() => declaredProjectId(f.dir)).toThrow('invalid');
    const id = uuidv7();
    writeFileSync(path.join(f.dir, 'navis.toml'), `project_id = "${id}"\n`);
    expect(declaredProjectId(f.dir)).toBe(id);
  });
  it.each(['120', 'Thu, 01 Jan 2099 00:00:00 GMT', 'invalid'])(
    'preserves a bounded retry deadline for %s',
    async (header) => {
      const f = fixture();
      const client = new NavisClient(
        await endpoint(429, 'gateway unavailable', { 'retry-after': header }),
        f.file,
      );
      try {
        await client.request('GET', '/limited');
        expect.fail('expected refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteError);
        if (error instanceof RemoteError) {
          expect(error.status).toBe(429);
          expect(error.retryAfter === undefined).toBe(header === 'invalid');
        }
      }
    },
  );
  it('refuses successful responses with invalid JSON', async () => {
    const f = fixture();
    await expect(
      new NavisClient(await endpoint(200, 'not-json'), f.file).request('GET', '/bad'),
    ).rejects.toThrow('invalid-json');
  });
});
