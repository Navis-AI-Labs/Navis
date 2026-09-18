# Tasks: minimal-read-surface

## 1. Kernel read surface

- [x] 1.1 Add `listAssets(): AssetRow[]` to `packages/domain/src/state/project-state-kernel.ts` — returns all alive assets that pass `scopeVisibleForProject(a.scope)`; do not re-derive scope logic inline. Requirement: equip derivation spec (same capability; read and equip derivation share the predicate). Verify: `pnpm --filter @navis/domain test`.
- [x] 1.2 Add `getAssetById(id: string): AssetRow | undefined` — returns the row only if alive AND in scope; otherwise `undefined` (so the caller receives the same answer for out-of-scope as for genuinely absent). Same file. Verify: `pnpm --filter @navis/domain test`.

## 2. Regression tests

- [x] 2.1 New test file `packages/domain/test/minimal-read-surface.test.ts`: covers BOTH paths attach the predicate — list (participant-scope hidden), get-by-id (out-of-scope → undefined), the "same answer for absent vs out-of-scope" pins. Verify: `pnpm exec vitest run packages/domain/test/minimal-read-surface.test.ts`.
- [x] 2.2 Integration test in the same file: `listing.getAssetById(outOfScopeRow.id)` returns undefined; `json exists in kernel.projection.assets[id]` → cross-scope leak rule holds.

## 3. Gate

- [x] 3.1 `pnpm validate` fully green.
- [x] 3.2 `pnpm exec openspec validate minimal-read-surface --strict` passes.
- [x] 3.3 No commit/push without both 3.1 and 3.2 passing on the final diff.
