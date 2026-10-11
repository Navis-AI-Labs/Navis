import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Single-instance advisory lock for one user's credential profile.
 * Separate profiles keep independent holders and IPC endpoints.
 *
 * Two cooperators: the lock file carries the holder's pid, and its presence
 * answers "someone already holds this slot" through atomic hard-link publication. A pid
 * that no longer signals means the holder died (`SIGKILL`-safe): the new
 * starter steals the slot by replacing the stale entry. This is advisory,
 * not exclusion — the point is that cooperative callers converge on one
 * process, not police misbehaving ones.
 */

export interface LockLease {
  readonly pid: number;
  /** Releases the slot; idempotent. No-op after a manual release. */
  release(): Promise<void>;
}

export type AcquireResult =
  | { readonly kind: 'acquired'; readonly lease: LockLease }
  | { readonly kind: 'held-by-live'; readonly pid: number };

export interface InstanceLockPort {
  acquire(): Promise<AcquireResult>;
  /**
   * Reads the held pid without acquiring anything; `null` when no live
   * holder exists. Pure observation — never spawns or steals.
   */
  probe(): Promise<number | null>;
}

class FilesystemLease implements LockLease {
  readonly #lockPath: string;
  #released = false;

  constructor(
    lockPath: string,
    readonly pid: number,
  ) {
    this.#lockPath = lockPath;
  }

  release(): Promise<void> {
    /* v8 ignore next 1 -- release is idempotent by construction */
    if (this.#released) return Promise.resolve();
    this.#released = true;
    /* v8 ignore next 6 -- the catch lambda only runs on a raced release */
    return fs.promises.unlink(this.#lockPath).catch((error: unknown) => {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    });
  }
}

/** Returns the live holder's pid, or null when the process is gone. */
function livePidOf(content: string): number | null {
  const pid = Number.parseInt(content.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // signal 0 is the "does this process exist" probe — throws only on death
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      try {
        const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
        const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
        // An unreaped child still accepts signal 0 but cannot serve IPC or retain a lease.
        if (state === 'Z' || state === 'X') return null;
      } catch {
        // Restricted or unmounted procfs leaves the successful signal probe authoritative.
      }
    }
    return pid;
  } catch {
    return null;
  }
}

export class NodeInstanceLock implements InstanceLockPort {
  readonly #lockPath: string;

  constructor(lockPath: string) {
    this.#lockPath = lockPath;
  }

  async acquire(): Promise<AcquireResult> {
    await fs.promises.mkdir(path.dirname(this.#lockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // Publish only a fully written PID record, so another starter cannot mistake an empty file for a dead owner.
        const candidate = `${this.#lockPath}.${randomBytes(8).toString('hex')}`;
        await fs.promises.writeFile(candidate, String(process.pid), { flag: 'wx', mode: 0o600 });
        try {
          await fs.promises.link(candidate, this.#lockPath);
        } finally {
          await fs.promises.unlink(candidate);
        }
        return { kind: 'acquired', lease: new FilesystemLease(this.#lockPath, process.pid) };
      } catch (error) {
        /* v8 ignore next 2 -- EEXIST is the only codified outcome here */
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        const held = await this.probe();
        if (held !== null) return { kind: 'held-by-live', pid: held };
        // stale entry: the holder died mid-crash — reclaim and retry once
        if (attempt === 0)
          await fs.promises.unlink(this.#lockPath).catch((failure: unknown) => {
            if (!(failure instanceof Error) || (failure as NodeJS.ErrnoException).code !== 'ENOENT')
              throw failure;
          });
      }
    }
    /* v8 ignore start -- this point is reachable only when two processes steal the same dead slot */
    const held = await this.probe();
    if (held === null) throw new Error('lock became uncontended after retry');
    return { kind: 'held-by-live', pid: held };
  }
  /* v8 ignore stop */

  async probe(): Promise<number | null> {
    let content: string;
    try {
      content = await fs.promises.readFile(this.#lockPath, 'utf8');
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      /* v8 ignore next 1 -- stat passed; only a real I/O fault throws here */
      throw error;
    }
    return livePidOf(content);
  }
}
