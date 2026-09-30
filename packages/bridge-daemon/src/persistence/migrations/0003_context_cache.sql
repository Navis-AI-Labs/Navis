-- Context cache: per-project snapshot of the structured context summary the
-- daemon last injected at session start (spec: context loading is driven by
-- state_version). Everything lives locally so a session starting offline can
-- still surface a cached summary marked stale with its cache timestamp.
CREATE TABLE context_cache (
  project_id TEXT PRIMARY KEY,
  state_version INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  cached_at TEXT NOT NULL
);

CREATE INDEX context_cache_cached_at ON context_cache (cached_at);
