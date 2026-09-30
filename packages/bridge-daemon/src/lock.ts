import fs from 'node:fs';
import path from 'node:path';

/**
 * Single-instance advisory lock (spec: a daemon runs exactly once per user;
 * a second connect reuses it, never spawns).
 *
 * Two cooperators: the lock file carries the holder's pid, and its presence
 * answers "someone already holds this slot" atomically via O_EXCL. A pid
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
    await fs.promises.mkdir(path.dirname(this.#lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // O_EXCL: the create itself is the atomic test
        const handle = await fs.promises.open(this.#lockPath, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        return { kind: 'acquired', lease: new FilesystemLease(this.#lockPath, process.pid) };
      } catch (error) {
        /* v8 ignore next 2 -- EEXIST is the only codified outcome here */
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        const held = await this.probe();
        if (held !== null) return { kind: 'held-by-live', pid: held };
        // stale entry: the holder died mid-crash — reclaim and retry once
        if (attempt === 0) await fs.promises.unlink(this.#lockPath);
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
