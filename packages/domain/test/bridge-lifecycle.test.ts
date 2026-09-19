import { describe, expect, it } from 'vitest';

import { InMemoryBridgeLifetime } from '../src/index.js';

/*
 * Contract pins for the bridge-lifecycle spec. Each test maps to one
 * scenario in openspec/specs/bridge-lifecycle/spec.md.
 */

describe('bridge lifecycle contract', () => {
  it('first connection spawns the daemon', async () => {
    const bridge = new InMemoryBridgeLifetime();
    expect(bridge.probe()).toBe('missing');
    const first = await bridge.ensureRunning();
    expect(first.created).toBe(true);
    expect(Number.isInteger(first.pid)).toBe(true);
    expect(bridge.probe()).toBe('running');
  });

  it('every later connect reuses the same pid (created=false)', async () => {
    const bridge = new InMemoryBridgeLifetime();
    const first = await bridge.ensureRunning();
    const second = await bridge.ensureRunning();
    expect(second.created).toBe(false);
    expect(second.pid).toBe(first.pid);

    // Concurrency: three simultaneous callers agree on pid and exactly one created=true.
    const raceResults = await Promise.all([
      bridge.ensureRunning(),
      bridge.ensureRunning(),
      bridge.ensureRunning(),
    ]);
    expect(raceResults.map((r) => r.pid).every((p) => p === first.pid)).toBe(true);
    expect(raceResults.filter((r) => r.created)).toHaveLength(0);
  });

  it('concurrent cold callers converge: exactly one created=true', async () => {
    const bridge = new InMemoryBridgeLifetime();
    const results = await Promise.all([
      bridge.ensureRunning(),
      bridge.ensureRunning(),
      bridge.ensureRunning(),
      bridge.ensureRunning(),
    ]);
    // All pids equal; exactly one created=true.
    const pids = new Set(results.map((r) => r.pid));
    expect(pids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('exit fires each hook exactly once and probe reports missing', async () => {
    const bridge = new InMemoryBridgeLifetime();
    await bridge.ensureRunning();
    const calls: string[] = [];
    bridge.onExit(() => calls.push('a'));
    bridge.onExit(() => calls.push('b'));
    bridge.simulateExit();
    expect(calls).toEqual(['a', 'b']);
    bridge.simulateExit(); // nested/second exit: hooks must not re-fire.
    expect(calls).toEqual(['a', 'b']);
    expect(bridge.probe()).toBe('missing');
  });

  it('restart after exit returns a new pid', async () => {
    const bridge = new InMemoryBridgeLifetime();
    const first = await bridge.ensureRunning();
    bridge.simulateExit();
    const second = await bridge.ensureRunning();
    expect(second.created).toBe(true);
    expect(second.pid).not.toBe(first.pid);
  });

  it('onExit registrations after exit still work on the next lifetime', async () => {
    const bridge = new InMemoryBridgeLifetime();
    await bridge.ensureRunning();
    bridge.simulateExit();
    const calls: string[] = [];
    bridge.onExit(() => calls.push('late'));
    await bridge.ensureRunning();
    bridge.simulateExit();
    expect(calls).toEqual(['late']);
  });

  it('simulateExit on a cold adapter is a no-op', () => {
    const bridge = new InMemoryBridgeLifetime();
    const calls: string[] = [];
    bridge.onExit(() => calls.push('should-not-fire'));
    bridge.simulateExit();
    expect(calls).toHaveLength(0);
    expect(bridge.probe()).toBe('missing');
  });
});
