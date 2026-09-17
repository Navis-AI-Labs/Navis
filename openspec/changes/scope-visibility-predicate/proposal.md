# Proposal: scope-visibility-predicate

## Why

The Equip derivation today encodes the five-level asset-scope rule as a duplicated hard test (`scope === 'project'`) inside the kernel, and the same reading of the scope model will be inherited by every future read surface (list queries, GET-by-id, API). Each new surface would re-encode the rule in its own words, drifting silently from the others. The five-level semantics are already defined in the schema; what is missing is one named predicate that owns what "visible in this derivation" means. This change puts that predicate in the domain, adopts it at both derivation sites, and pins cross-scope isolation across every accepted level with kernel contract tests.

## What Changes

- Add a single domain predicate — `scopeVisibleForProject(scope: AssetScope): boolean` — in `packages/domain/src/state/scope-visibility.ts`: R0 semantics = `project` scope is visible inside a project; the narrower levels (`participant`, `session`, `task`) stay hidden until their owning attribution fields are introduced by a future change; `organization`-scope assets are likewise outside the project derivation (no project_id linkage for them today).
- Rewrite the two kernel derivation sites (verified_facts and active_assets inside issueEquip) to call the predicate instead of the literal `=== 'project'` check.
- Add scenarios pinning every level: project visible; participant/session/task hidden; organization hidden from project derivation — regardless of lifecycle.

## Capabilities

### Modified Capabilities

- `project-state-kernel`: the Equip requirement gains the predicate as the binding rule and the isolation scenarios for all five scope levels.

## Non-Goals

- No new read/query surfaces: this change does not introduce list or GET endpoints (that is the later read-surface baton, which will reuse this predicate).
- No hold narrowing: `active_holds` remains project-wide under this change (the Work-local narrowing is a separately adjudicated follow-up).
- No new schema attribution fields (participant/session/task ownership on assets stays out; the predicate's semantics for those levels is decided explicitly as "not visible" until ownership data exists).

## Impact

- `packages/domain`: one new module, two call-site rewrites in the kernel, one new test file; existing Equip behavior preserved (predicate today exact-matches the old rule for project-scope assets).
