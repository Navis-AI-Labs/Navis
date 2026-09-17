# Tasks: scope-visibility-predicate

## 1. Predicate

- [x] 1.1 Add `packages/domain/src/state/scope-visibility.ts`: `scopeVisibleForProject(scope: AssetScope): boolean` with a doc-encoded R0 rule (project visible; participant/session/task hidden until attribution fields are admitted; organization excluded from project derivation). — Requirement: Equip derives the working contract from project state; Standards: 00, 01, 03; Unit: packages/domain; Verify: `pnpm exec vitest run packages/domain/test/scope-visibility.test.ts`

## 2. Kernel adoption

- [x] 2.1 Rewrite the two Equip derivation sites in `packages/domain/src/state/project-state-kernel.ts` to call the predicate; no behavior change for any project-scope fixture. — Requirement: same; Standards: 01, 02; Unit: packages/domain; Verify: `pnpm exec vitest run packages/domain/test/state-kernel.test.ts`

## 3. Level-coverage tests

- [x] 3.1 Add `packages/domain/test/scope-visibility.test.ts`: predicate truth table for all five levels; and Equip-level scenarios (participant/session/task/organization assets excluded even under lifecycle=active, project asset included). — Requirement: same; Standards: 02; Unit: packages/domain; Verify: `pnpm exec vitest run packages/domain/test/scope-visibility.test.ts`

## 4. Gates

- [x] 4.1 `pnpm validate` exits 0 and `pnpm exec openspec validate scope-visibility-predicate --strict` passes. — Requirement: all; Standards: 02; Unit: repo; Verify: `pnpm validate && pnpm exec openspec validate scope-visibility-predicate --strict`
