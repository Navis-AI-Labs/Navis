import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import net from 'node:net';
import fs from 'node:fs';
import * as ipc from '../src/ipc.js';
import { NodeInstanceLock } from '../src/lock.js';
import { BridgeRuntime } from '../src/runtime/runtime.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NodeBridgeDaemon } from '../src/daemon.js';
import { NodeIpcServer, ipcPing } from '../src/ipc.js';
import { resolveDaemonPaths } from '../src/paths.js';
import { invokeBridge } from '../src/runtime/client.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function paths() {
  const dir = mkdtempSync('/tmp/nd-');
  dirs.push(dir);
  return resolveDaemonPaths({ env: { NAVIS_HOME: dir }, platform: 'darwin' });
}
it('releases its lock when the socket path is an ordinary file', async () => {
  const p = paths();
  const server = new NodeIpcServer(() => Promise.resolve({ ok: true }));
  await server.listen(p.socketPath);
  await server.close();
  writeFileSync(p.socketPath, 'not a socket');
  const daemon = new NodeBridgeDaemon({ paths: p });
  await expect(daemon.ensureRunning()).rejects.toThrow('occupied');
  expect(existsSync(p.lockPath)).toBe(false);
});
it('reclaims a socket left by a killed process', async () => {
  const p = paths();
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import net from 'node:net';import fs from 'node:fs';fs.mkdirSync(${JSON.stringify(p.runtimeDir)},{recursive:true,mode:448});net.createServer().listen(${JSON.stringify(p.socketPath)},()=>process.stdout.write('ready'));`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const daemon = new NodeBridgeDaemon({ paths: p });
  try {
    expect((await daemon.ensureRunning()).created).toBe(true);
    expect(await ipcPing(p.socketPath)).toMatchObject({ pid: process.pid });
  } finally {
    await daemon.stop();
  }
});
it('rejects an insecure runtime directory', async () => {
  const p = paths();
  const server = new NodeIpcServer(() => Promise.resolve({ ok: true }));
  await server.listen(p.socketPath);
  await server.close();
  chmodSync(p.runtimeDir, 0o755);
  await expect(server.listen(p.socketPath)).rejects.toThrow('private');
});
it('handles a reset peer without terminating the IPC listener', async () => {
  const p = paths();
  const emit = vi.spyOn(net.Server.prototype, 'emit');
  const server = new NodeIpcServer(() => Promise.resolve({ ok: true }));
  await server.listen(p.socketPath);
  const client = net.connect(p.socketPath);
  await once(client, 'connect');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const calls: readonly (readonly unknown[])[] = emit.mock.calls;
  const call = calls.find((args) => args[0] === 'connection');
  const socket: unknown = call?.[1];
  if (!(socket instanceof net.Socket)) throw new Error('connection missing');
  const closed = once(client, 'close');
  socket.emit('error', new Error('peer reset'));
  await closed;
  await server.close();
});
it('reports an unavailable Node executable as a startup failure', async () => {
  const p = paths();
  vi.stubEnv('NAVIS_HOME', p.dataDir);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
  if (!descriptor) throw new Error('runtime descriptor missing');
  Object.defineProperty(process, 'execPath', { ...descriptor, value: '/missing/navis-node' });
  try {
    await expect(invokeBridge({ op: 'status' }, p)).rejects.toThrow('startup failed');
  } finally {
    Object.defineProperty(process, 'execPath', descriptor);
  }
});
it.each([false, true])(
  'releases a newly acquired lock if a peer becomes reachable (stale socket: %s)',
  async (stale) => {
    const p = paths();
    const server = new NodeIpcServer(() => Promise.resolve({ ok: true }));
    await server.listen(p.socketPath);
    const probe = vi.spyOn(ipc, 'ipcPing').mockResolvedValueOnce(null);
    if (stale) probe.mockResolvedValueOnce(null);
    probe.mockResolvedValueOnce({ pid: process.pid });
    try {
      const daemon = new NodeBridgeDaemon({ paths: p });
      expect(await daemon.ensureRunning()).toEqual({ pid: process.pid, created: false });
      expect(existsSync(p.lockPath)).toBe(false);
      expect(existsSync(p.socketPath)).toBe(true);
    } finally {
      await server.close();
    }
  },
);
it.each(['ENOENT', 'EACCES'])('classifies raced stale-lock removal: %s', async (code) => {
  const p = paths();
  fs.mkdirSync(p.runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.lockPath, 'invalid dead holder');
  const unlink = fs.promises.unlink.bind(fs.promises);
  vi.spyOn(fs.promises, 'unlink').mockImplementation(async (file) => {
    if (file === p.lockPath) {
      if (code === 'ENOENT') await unlink(file);
      throw Object.assign(new Error('simulated filesystem failure'), { code });
    }
    return unlink(file);
  });
  const lock = new NodeInstanceLock(p.lockPath);
  if (code === 'EACCES') await expect(lock.acquire()).rejects.toThrow('filesystem failure');
  else {
    const acquired = await lock.acquire();
    expect(acquired.kind).toBe('acquired');
    vi.restoreAllMocks();
    if (acquired.kind === 'acquired') await acquired.lease.release();
  }
});
it('closes storage and reports a failed listener teardown without an unhandled rejection', async () => {
  const p = paths();
  const runtime = new BridgeRuntime(p);
  await runtime.start();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked below with the daemon as its explicit receiver.
  const stop = NodeBridgeDaemon.prototype.stop;
  vi.spyOn(NodeBridgeDaemon.prototype, 'stop').mockImplementation(async function (
    this: NodeBridgeDaemon,
  ) {
    await stop.call(this);
    throw new Error('listener teardown failed');
  });
  const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const originalExit = process.exitCode;
  try {
    expect(await runtime.handle({ op: 'stop' })).toEqual({ stopping: true });
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith('Bridge shutdown failed.\n');
    });
    expect(process.exitCode).toBe(1);
    await expect(runtime.close()).rejects.toThrow('listener teardown failed');
    const db = new DatabaseSync(path.join(p.dataDir, 'bridge.sqlite'));
    db.exec('BEGIN EXCLUSIVE; ROLLBACK');
    db.close();
  } finally {
    process.exitCode = originalExit;
  }
});
it.each(['Z', 'X', 'S', 'unavailable'])(
  'classifies Linux process liveness without mistaking zombies for live holders: %s',
  async (state) => {
    const p = paths();
    fs.mkdirSync(p.runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(p.lockPath, String(process.pid));
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!original) throw new Error('platform descriptor missing');
    const read = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      if (file === `/proc/${String(process.pid)}/stat`) {
        if (state === 'unavailable') throw new Error('procfs restricted');
        return `${String(process.pid)} (node worker) ${state} 1 2 3`;
      }
      return read(file, options);
    });
    Object.defineProperty(process, 'platform', { ...original, value: 'linux' });
    try {
      expect(await new NodeInstanceLock(p.lockPath).probe()).toBe(
        state === 'Z' || state === 'X' ? null : process.pid,
      );
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  },
);
