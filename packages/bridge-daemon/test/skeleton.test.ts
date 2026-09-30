import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeBridgeDaemon } from '../src/daemon.js';
import { NodeIpcServer, ipcPing } from '../src/ipc.js';
import { MemoryKeychain, PlatformKeychain, type ShellRunner } from '../src/keychain.js';
import { NodeInstanceLock } from '../src/lock.js';
import { resolveDaemonPaths } from '../src/paths.js';

/**
 * Bridge-daemon skeleton: single-instance gating, platform IPC parity, and
 * keychain storage (spec: daemon runs once per user; second connect reuses;
 * mac/linux share the Unix-socket path, win32 takes the named pipe).
 *
 * The IPC round-trip and the stale-lock reclaim run against a real socket +
 * tmp directory so failure modes — EADDRINUSE, dead pid, missing file —
 * are observed, not staged.
 */

const NOW = '2026-09-01T00:00:00.000Z';

/** One clean tmp root per test; sockets and locks live beside one another. */
function mkTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'navis-test-'));
}

const toTeardown = new Set<string>();

afterEach(() => {
  for (const dir of toTeardown) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* tmp cleanup races the daemon's own release */
    }
    toTeardown.delete(dir);
  }
});

describe('resolveDaemonPaths', () => {
  it('lays out the three platforms: data, runtime, socket, lock', () => {
    const home = `/home/tester`;
    const ios = resolveDaemonPaths({
      platform: 'darwin',
      env: {},
      home,
      uid: 501,
    });
    expect(ios.dataDir).toBe(path.join(home, 'Library', 'Application Support', 'navis-bridge'));
    expect(ios.runtimeDir).toMatch(/navis-bridge-run-501$/u);
    expect(ios.socketPath).toBe(path.join(ios.runtimeDir, 'bridge.sock'));
    expect(ios.keychainService).toBe('navis-bridge');

    const linuxXdg = resolveDaemonPaths({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/usr/share/x', XDG_RUNTIME_DIR: '/run/user/501' },
      home,
      uid: 501,
    });
    expect(linuxXdg.dataDir).toBe(path.join('/usr/share/x', 'navis-bridge'));
    expect(linuxXdg.runtimeDir).toBe(path.join('/run/user/501', 'navis-bridge'));
    expect(linuxXdg.socketPath).toBe(path.join('/run/user/501', 'navis-bridge', 'bridge.sock'));

    const win = resolveDaemonPaths({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', USERNAME: 'tester' },
      home,
      uid: 0,
    });
    expect(win.dataDir).toBe('C:\\Users\\tester\\AppData\\Local\\navis-bridge');
    expect(win.socketPath).toBe('\\\\.\\pipe\\navis-bridge-tester');
    // the win lock file lives in data, not runtime (no per-boot dir there)
    expect(win.lockPath).toBe(path.join(win.dataDir, 'daemon.lock'));
  });

  it('defaults read the live process environment', () => {
    const live = resolveDaemonPaths();
    expect(live.dataDir.length).toBeGreaterThan(0);
    expect(live.socketPath.length).toBeGreaterThan(0);
    expect(live.keychainAccount.length).toBeGreaterThan(0);
  });
});

describe('NodeInstanceLock', () => {
  it('acquires exactly once; the second call sees the live holder', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);
    const lock = new NodeInstanceLock(path.join(dir, 'daemon.lock'));

    const first = await lock.acquire();
    expect(first.kind).toBe('acquired');
    if (first.kind !== 'acquired') throw new Error('expected first to acquire');

    const second = await lock.acquire();
    expect(second).toMatchObject({ kind: 'held-by-live', pid: process.pid });

    await first.lease.release();
    await expect(lock.probe()).resolves.toBeNull();
    await expect(lock.acquire()).resolves.toMatchObject({ kind: 'acquired' });
  });

  it('reclaims a pid its holder has died out of', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);
    const lock = new NodeInstanceLock(path.join(dir, 'daemon.lock'));

    // a pid the kernel retired long ago is not a live holder
    fs.writeFileSync(path.join(dir, 'daemon.lock'), '99999999');
    const result = await lock.acquire();
    expect(result.kind).toBe('acquired');
  });

  it('a tampered lock file with no pid reads as absence, never an error', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);
    const lock = new NodeInstanceLock(path.join(dir, 'daemon.lock'));

    fs.writeFileSync(path.join(dir, 'daemon.lock'), 'not-a-pid');
    await expect(lock.probe()).resolves.toBeNull();
  });
});

describe('NodeIpcServer framing', () => {
  it('answers a malformed frame with ok=false rather than tearing down the socket', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);
    const server = new NodeIpcServer(() =>
      Promise.resolve({ ok: true, data: { pid: process.pid } }),
    );
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\navis-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        : path.join(dir, 'test.sock');
    await server.listen(socketPath);
    toTeardown.add(dir);

    const reply = await new Promise<{ ok: boolean }>((resolve) => {
      const socket = net.connect(socketPath);
      socket.on('connect', () => {
        socket.write('not-json\n');
      });
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        resolve(JSON.parse(buffer.subarray(0, newline).toString('utf8')) as { ok: boolean });
        socket.end();
      });
    });

    expect(reply.ok).toBe(false);
    await server.close();
  });

  it('a second bind on the same socket path rejects with EADDRINUSE', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\navis-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        : path.join(dir, 'test.sock');

    const first = new NodeIpcServer(() => Promise.resolve({ ok: true }));
    await first.listen(socketPath);

    const second = new NodeIpcServer(() => Promise.resolve({ ok: true }));
    await expect(second.listen(socketPath)).rejects.toThrow(/EADDRINUSE/u);
    await first.close();
  });

  it('close() on a never-started server is a no-op', async () => {
    const server = new NodeIpcServer(() => Promise.resolve({ ok: true }));
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('pinging an absent socket returns null instead of crashing', async () => {
    await expect(ipcPing('/tmp/nav-is-bridge-not-here.sock')).resolves.toBeNull();
  });

  it('a structurally malformed JSON frame replies ok=false without a handler trip', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);
    const server = new NodeIpcServer(() =>
      Promise.resolve({ ok: true, data: { pid: process.pid } }),
    );
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\navis-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        : path.join(dir, 'test.sock');
    await server.listen(socketPath);

    const reply = await new Promise<{ ok: boolean; detail?: string }>((resolve) => {
      const socket = net.connect(socketPath);
      socket.on('connect', () => {
        // valid JSON, but no `op` — the well-formed-frame guard fires
        socket.write(JSON.stringify({ oops: true }) + '\n');
      });
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        resolve(
          JSON.parse(buffer.subarray(0, newline).toString('utf8')) as {
            ok: boolean;
            detail?: string;
          },
        );
        socket.end();
      });
    });

    expect(reply.ok).toBe(false);
    expect(reply.detail).toBe('malformed-frame');
    await server.close();
  });

  it('partial frames accumulate across chunks and arrive whole', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);
    const server = new NodeIpcServer((req) => {
      return Promise.resolve({
        ok: true,
        data: req.op === 'whoami' ? { pid: process.pid } : { reason: 'nope' },
      });
    });
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\navis-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        : path.join(dir, 'test.sock');
    await server.listen(socketPath);

    const reply = await new Promise<{ ok: boolean }>((resolve) => {
      const socket = net.connect(socketPath);
      socket.on('connect', () => {
        const frame = JSON.stringify({ op: 'whoami' }) + '\n';
        // split the frame mid-string so the parser sees it arrive in pieces
        const mid = Math.floor(frame.length / 2);
        socket.write(frame.slice(0, mid));
        setImmediate(() => {
          socket.write(frame.slice(mid));
        });
      });
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        resolve(JSON.parse(buffer.subarray(0, newline).toString('utf8')) as { ok: boolean });
        socket.end();
      });
    });
    expect(reply.ok).toBe(true);
    await server.close();
  });
});

describe('MemoryKeychain', () => {
  it('round-trips a secret under a namespaced ref', async () => {
    const kc = new MemoryKeychain();
    const ref = { service: 'navis-bridge', account: 'device-key-tester' };

    await kc.set(ref, 'device-secret-1');
    await expect(kc.get(ref)).resolves.toBe('device-secret-1');
    await expect(kc.delete(ref)).resolves.toBe(true);
    await expect(kc.get(ref)).resolves.toBeNull();
    await expect(kc.delete(ref)).resolves.toBe(false);
  });
});

describe('PlatformKeychain (shim runner)', () => {
  it('returns a stored secret on a hit, trimmed of trailing whitespace', async () => {
    const runner: ShellRunner = () => Promise.resolve({ stdout: 's3cr3t\n', stderr: '' });
    const kc = new PlatformKeychain('linux', runner);
    await expect(kc.get({ service: 'svc', account: 'acct' })).resolves.toBe('s3cr3t');
  });

  it('rethrows a non-miss error from get (infrastructure faults are real failures)', async () => {
    const runner: ShellRunner = () => Promise.reject(new Error('dbus down'));
    const kc = new PlatformKeychain('linux', runner);
    await expect(kc.get({ service: 'svc', account: 'acct' })).rejects.toThrow('dbus down');
  });

  it('a miss on delete maps to false, not a leak', async () => {
    const runner: ShellRunner = () => Promise.reject(new Error('item not found'));
    const kc = new PlatformKeychain('linux', runner);
    await expect(kc.delete({ service: 'svc', account: 'acct' })).resolves.toBe(false);
  });

  it('rethrows a non-miss error from delete as well', async () => {
    const runner: ShellRunner = () => Promise.reject(new Error('dbus down'));
    const kc = new PlatformKeychain('linux', runner);
    await expect(kc.delete({ service: 'svc', account: 'acct' })).rejects.toThrow('dbus down');
  });

  /** The local CLI binary never runs on this host; a stub stands in. */
  const getMarkers = ['find-generic-password', 'lookup', 'FindAllByResource'];
  const stubRunner: ShellRunner = (_file, argv) => {
    const isGet = argv.some((a) => getMarkers.some((m) => a.includes(m)));
    if (isGet) {
      return Promise.reject(Object.assign(new Error('item not found'), { code: 'ENOENT' }));
    }
    return Promise.resolve({ stdout: 'ok', stderr: '' });
  };

  it.each(['darwin', 'linux', 'win32'] as const)(
    'maps a tui miss on %s to null',
    async (platform) => {
      const kc = new PlatformKeychain(platform, stubRunner);
      await expect(kc.get({ service: 'svc', account: 'acct' })).resolves.toBeNull();
    },
  );

  it.each(['darwin', 'linux', 'win32'] as const)(
    'routes set/delete to the platform CLI on %s',
    async (platform) => {
      const calls: string[][] = [];
      const runner: ShellRunner = (file, argv) => {
        calls.push([file, ...argv]);
        return Promise.resolve({ stdout: '', stderr: '' });
      };
      const kc = new PlatformKeychain(platform, runner);
      const ref = { service: 'navis-bridge', account: 'device-key-tester' };

      await kc.set(ref, 'secret-1');
      await kc.delete(ref);

      expect(calls.length).toBe(2);
      expect(['security', 'secret-tool', 'powershell']).toContain(calls[0]?.[0] ?? '');
      expect(['security', 'secret-tool', 'powershell']).toContain(calls[1]?.[0] ?? '');
    },
  );
});

describe('daemon lifecycle over IPC', () => {
  it('opens a Unix socket for ping; its pid answers the socket probe', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);

    const daemon = new NodeBridgeDaemon({
      paths: resolveDaemonPaths({
        platform: process.platform as 'darwin' | 'linux' | 'win32',
        env: { TMPDIR: dir },
        home: dir,
      }),
      keychain: new MemoryKeychain(),
      now: () => NOW,
    });

    const first = await daemon.ensureRunning();
    expect(first.created).toBe(true);
    expect(first.pid).toBe(process.pid);
    expect(daemon.probe()).toBe('running');

    const second = await ipcPing(
      resolveDaemonPaths({
        platform: process.platform as 'darwin' | 'linux' | 'win32',
        env: { TMPDIR: dir },
        home: dir,
      }).socketPath,
    );
    expect(second).not.toBeNull();

    // a second ensureRunning reuses the holder instead of spawning
    const again = await daemon.ensureRunning();
    expect(again.created).toBe(false);
    expect(again.pid).toBe(first.pid);

    await daemon.stop();
    expect(daemon.probe()).toBe('missing');
    await daemon.stop(); // idempotent
  });

  it('an unknown op replies ok=false without tearing the socket down', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);
    const daemon = new NodeBridgeDaemon({
      paths: resolveDaemonPaths({
        platform: process.platform as 'darwin' | 'linux' | 'win32',
        env: { TMPDIR: dir },
        home: dir,
      }),
      keychain: new MemoryKeychain(),
      now: () => NOW,
    });

    await daemon.ensureRunning();
    // ping + unknown-op: the transport answers; only the registered op passes the router
    const paths = resolveDaemonPaths({
      platform: process.platform as 'darwin' | 'linux' | 'win32',
      env: { TMPDIR: dir },
      home: dir,
    });
    const socket = net.connect(paths.socketPath);
    const reply = await new Promise<{ ok: boolean; detail?: string }>((resolve) => {
      socket.on('connect', () => {
        socket.write(JSON.stringify({ op: '#bogus' }) + '\n');
      });
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        resolve(
          JSON.parse(buffer.subarray(0, newline).toString('utf8')) as {
            ok: boolean;
            detail?: string;
          },
        );
        socket.end();
      });
    });
    expect(reply.ok).toBe(false);
    expect(reply.detail).toBe('unknown-op:#bogus');
    await daemon.stop();
  });

  it('a pinned lock holder short-circuits ensureRunning without a second probe trip', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);
    const root = resolveDaemonPaths({
      platform: process.platform as 'darwin' | 'linux' | 'win32',
      env: { TMPDIR: dir },
      home: dir,
    });
    // Hold the slot BEFORE the daemon starts: the ping probe misses (no socket),
    // then the lock says someone else owns it — the daemon defers, created=false
    const foreignLock = new NodeInstanceLock(root.lockPath);
    const foreign = await foreignLock.acquire();
    expect(foreign.kind).toBe('acquired');
    if (foreign.kind !== 'acquired') throw new Error('expected acquisition');
    expect(foreign.lease.pid).toBe(process.pid); // same process is the holder here

    const daemon = new NodeBridgeDaemon({
      paths: root,
      keychain: new MemoryKeychain(),
      now: () => NOW,
    });
    // held-by-live — this lock object IS the foreign holder, so ensureRunning defers
    const result = await daemon.ensureRunning();
    expect(result).toEqual({ pid: process.pid, created: false });
    expect(daemon.probe()).toBe('missing');
    await foreign.lease.release();
  });

  it('exposes its keychain and defaults the clock to the live time when none is given', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);
    // the adapter is injectable so the runner seam stays a test thing
    const daemon = new NodeBridgeDaemon({
      paths: resolveDaemonPaths({
        platform: process.platform as 'darwin' | 'linux' | 'win32',
        env: { TMPDIR: dir },
        home: dir,
      }),
      keychain: new MemoryKeychain(),
    });

    await daemon.keychain().set({ service: 'svc', account: 'acct' }, 'oid');
    await expect(daemon.keychain().get({ service: 'svc', account: 'acct' })).resolves.toBe('oid');

    // a caller that never passes `now` still gets a well-formed started_at via ping
    await daemon.ensureRunning();
    const socketPath = resolveDaemonPaths({
      platform: process.platform as 'darwin' | 'linux' | 'win32',
      env: { TMPDIR: dir },
      home: dir,
    }).socketPath;
    const ping = await new Promise<{ ok: boolean; data?: { started_at?: string } }>((resolve) => {
      const socket = net.connect(socketPath);
      socket.on('connect', () => {
        socket.write(JSON.stringify({ op: 'ping' }) + '\n');
      });
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        resolve(
          JSON.parse(buffer.subarray(0, newline).toString('utf8')) as {
            ok: boolean;
            data?: { started_at?: string };
          },
        );
        socket.end();
      });
    });
    expect(ping.ok).toBe(true);
    expect(ping.data?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    await daemon.stop();
  });

  it('fires the exit hook exactly once per teardown', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);
    const daemon = new NodeBridgeDaemon({
      paths: resolveDaemonPaths({
        platform: process.platform as 'darwin' | 'linux' | 'win32',
        env: { TMPDIR: dir },
        home: dir,
      }),
      keychain: new MemoryKeychain(),
      now: () => NOW,
    });

    let exits = 0;
    daemon.onExit(() => {
      exits += 1;
    });

    await daemon.ensureRunning();
    await daemon.stop();
    expect(exits).toBe(1);
  });

  it('replies to a client frame with the negotiated ok flag', async () => {
    const dir = mkTmpRoot();
    toTeardown.add(dir);
    const server = new NodeIpcServer((req) => {
      if (req.op === 'whoami') return Promise.resolve({ ok: true, data: { pid: process.pid } });
      return Promise.resolve({ ok: false, detail: 'unknown' });
    });
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\navis-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        : path.join(dir, 'test.sock');
    await server.listen(socketPath);

    const reply = await new Promise<{ ok: boolean }>((resolve) => {
      const socket = net.connect(socketPath);
      socket.on('connect', () => {
        socket.write(JSON.stringify({ op: 'whoami' }) + '\n');
      });
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        resolve(JSON.parse(buffer.subarray(0, newline).toString('utf8')) as { ok: boolean });
        socket.end();
      });
    });

    expect(reply.ok).toBe(true);
    await server.close();
  });
});
