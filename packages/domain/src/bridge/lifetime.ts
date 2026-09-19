/**
 * Lifecycle contract for the per-user Bridge daemon.
 *
 * The Bridge is a single Unix-socket process per user. Every connect path
 * MUST funnel through `ensureRunning` so cold starts spawn exactly once and
 * warm callers reuse the same identity. Exit detection is observable:
 * `onExit` hooks fire exactly once per teardown and `probe` then reports
 * `missing`.
 */
export interface BridgeLifetimePort {
  /** Fast liveness check: never spawns anything. */
  probe(): 'running' | 'missing';
  /**
   * Cold path spawns (returns created=true with a fresh identity); warm
   * path returns the same identity with created=false. Concurrent callers
   * converge on the same identity — exactly one of them sees created=true.
   */
  ensureRunning(): Promise<{ pid: number; created: boolean }>;
  /** Fires exactly once per teardown; subscriptions after exit see nothing. */
  onExit(cb: () => void): void;
}
