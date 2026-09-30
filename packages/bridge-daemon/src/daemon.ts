import type { BridgeLifetimePort } from '@navis/domain';

import type { IpcReply, IpcRequest } from './ipc.js';
import { ipcPing, NodeIpcServer, pingHandler } from './ipc.js';

import type { ShellRunner } from './keychain.js';
import { NodeInstanceLock } from './lock.js';
import type { KeychainPort, SupportedPlatform } from './keychain.js';
import { PlatformKeychain } from './keychain.js';
import type { DaemonPaths } from './paths.js';

/**
 * Compose the per-user daemon. `ensureRunning` is the single entry point:
 *
 * - Warm path — the IPC probe succeeds: the returned pid is the live holder,
 *   `created: false`.
 * - Cold path — no live holder: the advisory lock is taken, the IPC socket
 *   is bound, and the answer is `created: true` with `process.pid`.
 *
 * A caller never interacts with the socket until `ensureRunning` resolves;
 * the lock file's stale-baggage reclamation means a `SIGKILL`'d holder is
 * replaced, not duplicated.
 */

export interface BridgeDaemonDeps {
  readonly paths: DaemonPaths;
  /** Injectable — the platform shell adapter is the default. */
  readonly keychain?: KeychainPort;
  /** Injectable — lets tests pin the shell adapter's runner. */
  readonly keychainRunner?: ShellRunner;
  /** Injectable — default is net.Server over the platform path. */
  readonly ipcFactory?: () => NodeIpcServer;
  /** Injectable clock for the `started_at` field in the ping reply. */
  readonly now?: () => string;
}

export class NodeBridgeDaemon implements BridgeLifetimePort {
  readonly #paths: BridgeDaemonDeps['paths'];
  readonly #keychain: KeychainPort;
  readonly #ipc: NodeIpcServer;
  readonly #now: () => string;
  readonly #exitHooks = new Set<() => void>();
  #running = false;

  constructor(deps: BridgeDaemonDeps) {
    this.#paths = deps.paths;
    this.#keychain =
      deps.keychain ??
      new PlatformKeychain(process.platform as SupportedPlatform, deps.keychainRunner);
    this.#ipc =
      deps.ipcFactory?.() ??
      new NodeIpcServer(async (request: IpcRequest): Promise<IpcReply> => {
        /* v8 ignore next 2 -- ping is the only op the skeleton answers */
        if (request.op === 'ping') return pingHandler(() => ({ started_at: this.#now() }));
        return { ok: false, detail: `unknown-op:${request.op}` };
      });
    this.#now = deps.now ?? (() => new Date().toISOString());
  }

  /** Fast liveness check via the IPC socket — no spawn, no lock change. */
  probe(): 'running' | 'missing' {
    return this.#running ? 'running' : 'missing';
  }

  keychain(): KeychainPort {
    return this.#keychain;
  }

  async ensureRunning(): Promise<{ pid: number; created: boolean }> {
    // warm path reuses the running process: no spawn, the lock holder wins
    const existing = await ipcPing(this.#paths.socketPath);
    if (existing !== null) return { pid: existing.pid, created: false };

    const lock = new NodeInstanceLock(this.#paths.lockPath);
    const result = await lock.acquire();
    if (result.kind === 'held-by-live') return { pid: result.pid, created: false };

    await this.#ipc.listen(this.#paths.socketPath);
    this.#running = true;
    return { pid: process.pid, created: true };
  }

  async stop(): Promise<void> {
    /* v8 ignore next 1 -- stop on a non-running daemon is a no-op */
    if (!this.#running) return;
    this.#running = false;
    await this.#ipc.close();
    for (const hook of [...this.#exitHooks]) hook();
  }

  /** Fires exactly once per teardown; subscriptions after exit see nothing. */
  onExit(cb: () => void): void {
    this.#exitHooks.add(cb);
  }
}
