# Proposal: minimal-read-surface

## Why

Today the project kernel's projection is readable only by direct property access (`kernel.projection.assets[...]`), and consumers decide on their own whether a row is visible to them. There is no single, tested "read surface" through which an external reader (server route, worker, reporter, future Bridge/SDK consumer) asks for an asset and knows **the same scope-visibility filter was applied as everywhere else**. The R0 acceptance plan requires the scope predicate to be proven on both the list-query path and the GET-by-id path; that acceptance has no implementation until this change.

## What Changes

- Add a minimal read surface on the project kernel: a stable place where read clients ask for assets by id and list/filter assets, with the existing scope predicate applied (and documented as) non-optional on both paths.
- Pin it with regression tests proving: (1) the list path hides non-project-scope assets, (2) the get-by-id path returns not-found (not "leaked") for non-project-scope assets rather than handing them to the caller.

## Non-Goals

- No HTTP/API server layer, no auth middleware — that is the application/service concern, not this change (R1 for a web read surface).
- No pagination or cursor protocol — list is bounded by in-memory projection; deliberately documented as R0 scope.
- No change to the projection shape (Asset/Work/Equip/etc.) or to any command path.
- Not touching scope policy itself; the predicate already exists. This change only routes read paths through it.

## Capabilities

### Modified Capabilities

- `project-state-kernel` — requirement "equip is a derived contract carrying facts, holds, goal, criteria, and allowed effects" gains a sibling read-path scope guarantee (new scenarios): list and GET-by-id asset paths both route through the single scope predicate, and the hidden-scope case shows _not-found_, not an empty-leak.

## Impact

- `packages/domain/src/state/project-state-kernel.ts`: two new read methods (or a single `scopeFilter` helper + two thin query methods).
- `packages/domain/test/`: one new regression file proving both paths share the predicate and the leak case is not-found.
- No architecture layers touched; no persistence changes; no ADR needed (the rule change is one-size).
