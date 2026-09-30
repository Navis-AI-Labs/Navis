import { describe, expect, it } from 'vitest';

import { run, type CliDeps, type CliInvocation } from '../src/index.js';

/**
 * CLI routing is stateless — no module-level cache, every invocation re-reads
 * deps. The three hook outcomes map to the bridge-session-hook contract:
 * bound / reused / unbound.
 */

interface DepsWithSpies extends CliDeps {
  readonly stdoutLines: string[];
  readonly stderrLines: string[];
  readonly ipcCalls: Record<string, unknown>[];
}

function makeDeps(overrides?: Partial<CliDeps>): DepsWithSpies {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const ipcCalls: Record<string, unknown>[] = [];
  const fwdIpc = {
    send: (path: string, request: Record<string, unknown>): Promise<unknown> => {
      ipcCalls.push(request);
      if (overrides?.ipc !== undefined) return overrides.ipc.send(path, request);
      return Promise.resolve({ ok: true, pid: 42 });
    },
  };
  return {
    platform: 'darwin',
    ipc: fwdIpc,
    keychain: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
    },
    now: () => '2026-09-01T00:00:00.000Z',
    cwd: () => '/some/workdir',
    stdout: (line: string) => {
      stdoutLines.push(line);
    },
    stderr: (line: string) => {
      stderrLines.push(line);
    },
    stdoutLines,
    stderrLines,
    ipcCalls,
    ...(overrides !== undefined
      ? {
          ...(overrides.keychain !== undefined ? { keychain: overrides.keychain } : {}),
          ...(overrides.now !== undefined ? { now: overrides.now } : {}),
          ...(overrides.cwd !== undefined ? { cwd: overrides.cwd } : {}),
        }
      : {}),
  };
}

function inv(payload: Partial<CliInvocation>): CliInvocation {
  return {
    verb: 'init',
    args: [],
    flags: new Map<string, string | true>(),
    ...payload,
  };
}

describe('navis cli · stateless command routing', () => {
  it('init invokes daemon init over IPC with the resolved cwd', async () => {
    const deps = makeDeps();
    const code = await run(inv({ verb: 'init' }), deps);
    expect(code).toBe(0);
    expect(deps.ipcCalls[0]?.['op']).toBe('init');
    expect(deps.ipcCalls[0]?.['cwd']).toBe('/some/workdir');
  });

  it('status sends a status op and echoes the reply as JSON', async () => {
    const deps = makeDeps();
    const code = await run(inv({ verb: 'status' }), deps);
    expect(code).toBe(0);
    expect(deps.ipcCalls[0]?.['op']).toBe('status');
    expect(deps.stdoutLines[0]).toBe('{"ok":true,"pid":42}');
  });

  it('session sends a session.resume op', async () => {
    const deps = makeDeps();
    const code = await run(inv({ verb: 'session' }), deps);
    expect(code).toBe(0);
    expect(deps.ipcCalls[0]?.['op']).toBe('session.resume');
  });

  it('bridge link refuses to call the daemon without --toml', async () => {
    const deps = makeDeps();
    const code = await run(inv({ verb: 'bridge link' }), deps);
    expect(code).toBe(2);
    expect(deps.stderrLines[0]).toContain('--toml');
    expect(deps.ipcCalls.length).toBe(0);
  });

  it('bridge link forwards the toml flag opaque — the daemon validates it', async () => {
    const deps = makeDeps();
    const code = await run(
      inv({
        verb: 'bridge link',
        flags: new Map<string, string>([['toml', '/path/navis.toml']]),
      }),
      deps,
    );
    expect(code).toBe(0);
    expect(deps.ipcCalls[0]?.['op']).toBe('bridge.link');
    expect(deps.ipcCalls[0]?.['toml']).toBe('/path/navis.toml');
  });

  it('bridge unlink calls the daemon', async () => {
    const deps = makeDeps();
    const code = await run(inv({ verb: 'bridge unlink' }), deps);
    expect(code).toBe(0);
    expect(deps.ipcCalls[0]?.['op']).toBe('bridge.unlink');
  });

  it('bridge login stores the key in the OS keychain (never on disk)', async () => {
    const stored: { service: string; account: string; secret: string }[] = [];
    const deps = makeDeps({
      keychain: {
        get: () => Promise.resolve(null),
        set: (ref, secret) => {
          stored.push({ service: ref.service, account: ref.account, secret });
          return Promise.resolve();
        },
        delete: () => Promise.resolve(false),
      },
    });
    const code = await run(
      inv({
        verb: 'bridge login',
        flags: new Map<string, string>([['key', 'key-id.secret-secret']]),
      }),
      deps,
    );
    expect(code).toBe(0);
    expect(stored[0]?.secret).toBe('key-id.secret-secret');
    expect(stored[0]?.service).toMatch(/^navis-bridge/u);
    expect(deps.ipcCalls.length).toBe(0);
  });

  it('bridge login refuses an empty key with a named reason', async () => {
    const deps = makeDeps();
    const code = await run(inv({ verb: 'bridge login' }), deps);
    expect(code).toBe(2);
    expect(deps.stderrLines[0]).toContain('--key');
  });

  it('bridge hook of a first fire forwards the result with exit 0', async () => {
    const deps = makeDeps({
      ipc: {
        send: () =>
          Promise.resolve({
            status: 'bound',
            bound_source: 'toml',
            event_id: 'e1',
            project_id: 'p1',
            change_marker: 'advanced',
          }),
      },
    });
    const code = await run(
      inv({
        verb: 'bridge hook',
        flags: new Map<string, string | true>([['toml-present', true]]),
      }),
      deps,
    );
    expect(code).toBe(0);
    const line = deps.stdoutLines[0];
    expect(line).toBeDefined();
    expect(JSON.parse(line ?? '')).toMatchObject({ status: 'bound' });
    expect(deps.ipcCalls[0]?.['op']).toBe('hook.session.start');
  });

  it('bridge hook of a reused request returns the same event id with exit 0', async () => {
    const deps = makeDeps({
      ipc: {
        send: () => Promise.resolve({ status: 'reused', event_id: 'e9' }),
      },
    });
    const code = await run(inv({ verb: 'bridge hook' }), deps);
    expect(code).toBe(0);
    expect(JSON.parse(deps.stdoutLines[0] ?? '')).toMatchObject({ event_id: 'e9' });
  });

  it('bridge hook of an unbound session reports the reason and exits 1', async () => {
    const deps = makeDeps({
      ipc: {
        send: () => Promise.resolve({ status: 'unbound', reason: 'no-navis-toml' }),
      },
    });
    const code = await run(inv({ verb: 'bridge hook' }), deps);
    expect(code).toBe(1);
    expect(JSON.parse(deps.stdoutLines[0] ?? '')).toMatchObject({
      status: 'unbound',
      reason: 'no-navis-toml',
    });
  });

  it('unknown verb exits 2 without touching the daemon', async () => {
    const deps = makeDeps();
    const code = await run(
      inv({
        verb: 'definitely-not-a-verb',
      }),
      deps,
    );
    expect(code).toBe(2);
    expect(deps.ipcCalls.length).toBe(0);
  });

  it('two invocations in the same process are stateless — no cache bleed', async () => {
    const deps = makeDeps();
    const first = await run(inv({ verb: 'status' }), deps);
    const second = await run(inv({ verb: 'status' }), deps);
    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(deps.ipcCalls.length).toBe(2);
    expect(deps.ipcCalls[0]?.['op']).toBe('status');
    expect(deps.ipcCalls[1]?.['op']).toBe('status');
  });
});
