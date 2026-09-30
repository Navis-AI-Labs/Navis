import type { DatabaseSync } from 'node:sqlite';

/**
 * Context loader (spec: context loading is driven by state version, not
 * session count). Session start asks the daemon for project context: the
 * daemon compares the server's state_version with what it last loaded and
 * returns one of three outcomes:
 *
 *   - `no_change`: version equal → no-change marker, cached summary, zero
 *     re-injection traffic.
 *   - `fresh`: version advanced (or first load) → the new summary is
 *     cached with the current time and returned in full.
 *   - `stale`: network unreachable → the cached summary comes back marked
 *     stale with its cache timestamp. First-ever-offline load is an error
 *     path the caller must name, never infer.
 */

export interface ContextSummary {
  readonly project_name: string;
  readonly status: string;
  readonly state_version: number;
  readonly active_work_count: number;
  readonly open_hold_count: number;
  readonly last_update: string;
}

export type ContextLoadOutcome =
  | { readonly kind: 'no_change'; readonly summary: ContextSummary }
  | { readonly kind: 'fresh'; readonly summary: ContextSummary }
  | {
      readonly kind: 'stale';
      readonly summary: ContextSummary;
      readonly cached_at: string;
    }
  | { readonly kind: 'unavailable'; readonly projectId: string };

export interface ContextSourcePort {
  /**
   * Fetch the current summary from the server; throws when the network is
   * unavailable — the caller specifies meaning, not this port.
   */
  fetch(projectId: string): Promise<ContextSummary>;
}

interface CachedRow {
  readonly state_version: number;
  readonly summary_json: string;
  readonly cached_at: string;
}

export class SqliteContextCache {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  read(projectId: string): (ContextSummary & { readonly cached_at: string }) | null {
    const row = this.#db
      .prepare(
        'SELECT state_version, summary_json, cached_at FROM context_cache WHERE project_id = ?',
      )
      .get(projectId) as CachedRow | undefined;
    if (row === undefined) return null;
    const summary = JSON.parse(row.summary_json) as ContextSummary;
    return { ...summary, cached_at: row.cached_at };
  }

  write(projectId: string, summary: ContextSummary, cachedAt: string): void {
    this.#db
      .prepare(
        `INSERT INTO context_cache (project_id, state_version, summary_json, cached_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET
           state_version = excluded.state_version,
           summary_json = excluded.summary_json,
           cached_at = excluded.cached_at`,
      )
      .run(projectId, summary.state_version, JSON.stringify(summary), cachedAt);
  }
}

/**
 * Load project context against the stored state_version: advance → cache + `fresh`;
 * equal → `no_change` from cache; fetch failure → cached summary marked `stale`,
 * or explicit `unavailable` when no cache exists at all.
 */
export async function loadProjectContext(
  source: ContextSourcePort,
  cache: SqliteContextCache,
  projectId: string,
  nowIso: string,
): Promise<ContextLoadOutcome> {
  const cached = cache.read(projectId);

  let remote: ContextSummary;
  try {
    remote = await source.fetch(projectId);
  } catch {
    // network failure: surface cache when there is any, else name the void
    if (cached !== null) {
      const { cached_at, ...summary } = cached;
      return { kind: 'stale', summary, cached_at };
    }
    return { kind: 'unavailable', projectId };
  }

  /* v8 ignore next 1 -- no-change with no cache is logically impossible:
     the version comparison needs a remembered version, which lives in cache */
  if (cached !== null && cached.state_version === remote.state_version) {
    return { kind: 'no_change', summary: remote };
  }

  cache.write(projectId, remote, nowIso);
  return { kind: 'fresh', summary: remote };
}
