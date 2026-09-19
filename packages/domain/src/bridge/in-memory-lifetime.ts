import type { BridgeLifetimePort } from './lifetime.js';

/**
 * Reference implementation of the Bridge lifecycle contract.
 *
 * Design-verification artifact: sequential PIDs stand in for real process
 * ids, and `simulateExit()` replaces the OS signal. The real R1 adapter
 * keeps the same semantics against an actual Unix-socket daemon.
 */
export class InMemoryBridgeLifetime implements BridgeLifetimePort {
  #running: number | null = null;
  #nextPid = 1000;
  readonly #exitHooks = new Set<() => void>();

  probe(): 'running' | 'missing' {
    return this.#running === null ? 'missing' : 'running';
  }

  ensureRunning(): Promise<{ pid: number; created: boolean }> {
    // The method returns a Promise to keep the contract in lockstep with a
    // real async socket-backed implementation, even though the in-memory
    // variant has nothing to await. Returning Promise.resolve preserves that.
    if (this.#running !== null) return Promise.resolve({ pid: this.#running, created: false });
    this.#running = this.#nextPid;
    this.#nextPid += 1;
    return Promise.resolve({ pid: this.#running, created: true });
  }

  onExit(cb: () => void): void {
    this.#exitHooks.add(cb);
  }

  /** Test seam: simulates the daemon disappearing. */
  simulateExit(): void {
    if (this.#running === null) return;
    this.#running = null;
    for (const hook of [...this.#exitHooks]) hook();
  }
}
