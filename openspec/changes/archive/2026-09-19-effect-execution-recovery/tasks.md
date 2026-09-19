# Tasks: effect-execution-recovery

## 1. Kernel state extension

- [x] 1.1 Add `"executing"` to `EffectRow.status` enum and `execution_attempts: number` (optional) to `packages/domain/src/state/projection.ts`. Verify: `pnpm --filter @navis/domain build`.

## 2. Event schema additions

- [x] 2.1 New payloads in event-data: `effect_execution_begun_data` `{ effect_id }`, `effect_execution_reset_data` `{ effect_id, reason, attempts_next }`. Verify: `pnpm --filter @navis/domain build`.

## 3. Kernel commands & exits

- [x] 3.1 Add `listExecutingEffects()`; add `beginEffectExecution` command (unknown→executing per spec); extend `closeEffect` guard so only `executing` may close; add `resetEffectExecution` (executing→unknown, attempts++). Extend `fromReplay` cases. Verify: `pnpm exec vitest run packages/domain/test/effect-ledger-intent-first.test.ts` (must fix regressions there) and new test file.

## 4. Regression tests

- [x] 4.1 New `packages/domain/test/effect-execution-recovery.test.ts` pinning the spec scenarios.
- [x] 4.2 Update existing E1 (intent-first) suite to route closure through `beginEffectExecution`.

## 5. Gate

- [x] 5.1 `pnpm validate` fully green; openspec strict green.
- [x] 5.2 Commit + push English-only. Wait for CI success before touching the consolidation docs again.
