import { uuidv7 } from '@navis/domain';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeIpcServer } from '../src/ipc.js';
import { sendBridge, invokeBridge } from '../src/runtime/client.js';
import { resolveDaemonPaths } from '../src/paths.js';
import { fileURLToPath } from 'node:url';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
function folder() {
  const dir = mkdtempSync('/tmp/ni-');
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
    return Promise.resolve();
  });
  return dir;
}
async function peer(answer: string | null) {
  const dir = folder();
  const socketPath = `${dir}/peer.sock`;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => {
      if (answer !== null) socket.end(answer);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  );
  return socketPath;
}
describe('bounded IPC and packaged process startup', () => {
  it.each(['not-json\n', '{}\n', '{"ok":false,"detail":"refused"}\n', '{"ok":false}\n'])(
    'rejects malformed or denied replies',
    async (answer) => {
      await expect(sendBridge({ op: 'status' }, await peer(answer))).rejects.toThrow();
    },
  );
  it('times out silent peers and rejects missing listeners', async () => {
    await expect(sendBridge({ op: 'status' }, await peer(null), 5)).rejects.toThrow('timed out');
    await expect(sendBridge({ op: 'status' }, `${folder()}/missing.sock`)).rejects.toThrow();
  });
  it('bounds responses and input frames before processing', async () => {
    await expect(sendBridge({ op: 'status' }, await peer('x'.repeat(16_777_217)))).rejects.toThrow(
      'too large',
    );
    await expect(
      sendBridge(
        {
          op: 'capture',
          event_id: uuidv7(),
          cwd: '/',
          step: { kind: 'tool.call.result', tool: 'test', result: 'x'.repeat(524_288) },
          session_id: 's',
          privacy: 'metadata',
        },
        '/unused',
      ),
    ).rejects.toThrow('too large');
  });
  it('closes idle, oversized and pipelined connections without invoking handlers', async () => {
    const dir = folder();
    const socketPath = `${dir}/server.sock`;
    const handler = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const server = new NodeIpcServer(handler, { timeoutMs: 5, maxFrameBytes: 64 });
    await server.listen(socketPath);
    cleanups.push(() => server.close());
    for (const input of [null, 'x'.repeat(65), '{"op":"status"}\n{"op":"status"}\n'])
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(socketPath);
        socket.on('error', reject);
        socket.on('close', () => {
          resolve();
        });
        socket.on('connect', () => {
          if (input !== null) socket.write(input);
        });
      });
    expect(handler).not.toHaveBeenCalled();
  });
  it('reassembles partial frames and sanitizes malformed requests', async () => {
    const dir = folder();
    const socketPath = `${dir}/server.sock`;
    const server = new NodeIpcServer(() => Promise.resolve({ ok: true, data: 'valid' }));
    await server.listen(socketPath);
    cleanups.push(() => server.close());
    const raw = (parts: string[]) =>
      new Promise<string>((resolve, reject) => {
        const socket = net.connect(socketPath);
        let output = '';
        socket.on('error', reject);
        socket.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        socket.on('end', () => {
          resolve(output);
        });
        socket.on('connect', () => {
          parts.forEach((part, index) => {
            setTimeout(() => socket.write(part), index * 20);
          });
        });
      });
    expect(JSON.parse(await raw(['{"op":', '"status"}\n']))).toMatchObject({
      ok: true,
      data: 'valid',
    });
    expect(JSON.parse(await raw(['{}\n']))).toMatchObject({ ok: false, detail: 'malformed-frame' });
    expect(JSON.parse(await raw(['invalid\n']))).toMatchObject({ ok: false });
  });
  it('starts the packaged daemon once and reuses it', async () => {
    const dir = folder();
    vi.stubEnv('NAVIS_HOME', dir);
    const paths = resolveDaemonPaths();
    const entry = fileURLToPath(new URL('../dist/process/index.js', import.meta.url));
    const status = (await invokeBridge({ op: 'status' }, paths, entry)) as {
      pid: number;
      configured: boolean;
    };
    cleanups.push(async () => {
      try {
        await sendBridge({ op: 'stop' }, paths.socketPath);
      } catch {
        // The child may already have exited after serving the last request.
      }
      for (let i = 0; i < 30; i++) {
        try {
          process.kill(status.pid, 0);
        } catch {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      process.kill(status.pid, 'SIGKILL');
    });
    expect(status.pid).not.toBe(process.pid);
    expect(await invokeBridge({ op: 'status' }, paths, entry)).toMatchObject({
      pid: status.pid,
      configured: false,
    });
  });
  it('reports a packaged startup failure rather than waiting indefinitely', async () => {
    const dir = folder();
    vi.stubEnv('NAVIS_HOME', dir);
    await expect(
      invokeBridge({ op: 'status' }, resolveDaemonPaths(), '/missing/navis-entry.js'),
    ).rejects.toThrow('startup failed');
  });
  it('converges concurrent cold starts on one daemon and replaces a killed holder', async () => {
    const dir = folder();
    vi.stubEnv('NAVIS_HOME', dir);
    const paths = resolveDaemonPaths();
    const entry = fileURLToPath(new URL('../dist/process/index.js', import.meta.url));
    const holders = new Set<number>();
    cleanups.push(() => {
      for (const pid of holders) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // A previous round deliberately killed this holder.
        }
      }
      return Promise.resolve();
    });
    for (let round = 0; round < 3; round++) {
      const replies = await Promise.all(
        Array.from({ length: 8 }, () => invokeBridge({ op: 'status' }, paths, entry)),
      );
      const pids = replies.map((reply) => {
        if (typeof reply !== 'object' || reply === null || !('pid' in reply))
          throw new Error('missing daemon identity');
        if (typeof reply.pid !== 'number') throw new Error('invalid daemon identity');
        return reply.pid;
      });
      expect(new Set(pids).size).toBe(1);
      const pid = pids[0];
      if (pid === undefined) throw new Error('no daemon started');
      expect(holders.has(pid)).toBe(false);
      holders.add(pid);
      process.kill(pid, 'SIGKILL');
      // Wait for death, so the next round exercises stale lock/socket recovery.
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
      });
    }
  });
});
