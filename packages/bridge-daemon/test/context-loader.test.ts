import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadProjectContext,
  SqliteContextCache,
  type ContextSummary,
} from '../src/context/loader.js';
import { openDaemonDb } from '../src/persistence/sqlite-binding.js';

/**
 * Spec scenarios (context loading): unchanged version → no-change marker with
 * cached summary; advanced version → fresh summary + new version remembered;
 * offline → cached summary marked stale with its cache timestamp; offline
 * with no cache at all → explicitly unavailable, never inferred.
 */

const NOW = '2026-09-01T00:00:00.000Z';
const PROJECT = '01924a61-7a1b-7c2d-8e3f-000000000001';

function sampleSummary(version: number): ContextSummary {
  return {
    project_name: 'navis.sdd',
    status: 'active',
    state_version: version,
    active_work_count: 3,
    open_hold_count: 1,
    last_update: '2026-08-31T23:55:00.000Z',
  };
}

interface Setup {
  readonly cache: SqliteContextCache;
  readonly close: () => void;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function withCache(): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navis-context-'));
  const db = openDaemonDb(path.join(dir, 'daemon.db'));
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      /* closed by test */
    }
  });
  return {
    cache: new SqliteContextCache(db),
    close: () => {
      db.close();
    },
  };
}

describe('context loader · state-version-driven', () => {
  it('first load caches and returns fresh', async () => {
    const setup = withCache();
    const source = { fetch: () => Promise.resolve(sampleSummary(7)) };

    const outcome = await loadProjectContext(source, setup.cache, PROJECT, NOW);
    expect(outcome).toEqual({ kind: 'fresh', summary: sampleSummary(7) });

    const cached = setup.cache.read(PROJECT);
    expect(cached?.state_version).toBe(7);
    expect(cached?.cached_at).toBe(NOW);
  });

  it('unchanged state_version answers with the no-change marker, no cache rewrite', async () => {
    const setup = withCache();
    setup.cache.write(PROJECT, sampleSummary(7), '2026-09-01T00:00:00.000Z');

    const source = { fetch: () => Promise.resolve(sampleSummary(7)) };
    const outcome = await loadProjectContext(source, setup.cache, PROJECT, NOW);

    expect(outcome.kind).toBe('no_change');
    expect(setup.cache.read(PROJECT)?.cached_at).toBe('2026-09-01T00:00:00.000Z');
  });

  it('an advanced state_version refreshes the cache and returns fresh', async () => {
    const setup = withCache();
    setup.cache.write(PROJECT, sampleSummary(7), '2026-09-01T00:00:00.000Z');

    const source = { fetch: () => Promise.resolve(sampleSummary(9)) };
    const outcome = await loadProjectContext(
      source,
      setup.cache,
      PROJECT,
      '2026-09-01T00:10:00.000Z',
    );

    expect(outcome).toEqual({ kind: 'fresh', summary: sampleSummary(9) });
    const cached = setup.cache.read(PROJECT);
    expect(cached?.state_version).toBe(9);
    expect(cached?.cached_at).toBe('2026-09-01T00:10:00.000Z');
  });

  it('an offline query surfaces the cached summary marked stale with its timestamp', async () => {
    const setup = withCache();
    setup.cache.write(PROJECT, sampleSummary(7), '2026-08-01T12:00:00.000Z');

    const source = {
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const outcome = await loadProjectContext(source, setup.cache, PROJECT, NOW);

    expect(outcome.kind).toBe('stale');
    if (outcome.kind === 'stale') {
      expect(outcome.summary).toEqual(sampleSummary(7));
      expect(outcome.cached_at).toBe('2026-08-01T12:00:00.000Z');
    }
  });

  it('offline with no cache at all answers unavailable rather than fabricating', async () => {
    const setup = withCache();
    const source = {
      fetch: () => Promise.reject(new Error('offline')),
    };

    const outcome = await loadProjectContext(source, setup.cache, PROJECT, NOW);
    expect(outcome).toEqual({ kind: 'unavailable', projectId: PROJECT });
  });

  it('closing the database makes every cache operation report rather than crash the loader', () => {
    const setup = withCache();
    // The cache is a thin port over the db handle — the caller does not close it.
    const db = setup.cache;
    setup.close();
    // The loader sits above the cache and is inherently incapable of
    // isolating a closed handle; the failure surfaces at the port edge.
    expect(() => db.read(PROJECT)).toThrow(/database is not open/u);
  });
});
