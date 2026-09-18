# Tasks: effect-ledger-intent-first

## 1. Kernel — intent-first commands and events

- [x] 1.1 Add event vocabulary: `effect.intent_recorded` (payload: effect_id, intent_key, actor, optional asset_ref/description) and `effect.cancel_recorded` (payload: effect_id, actor). Requirement: the effect ledger intent-first mod (project-state-kernel). Standards: `01-source-code.md` variants. Verify: `pnpm --filter @navis/domain build`.
- [x] 1.2 Add `EffectRow.intent_key?: string` and `EffectRow.late_cancel_received?: boolean` to the projection schema. Standards: `01-source-code.md` (Zod single-source), `07-data-and-persistence.md`. Verify: `pnpm --filter @navis/domain typecheck`.
- [x] 1.3 Add `recordEffectIntent` command: validates fields (`intent_key` format = UUIDv7, actor present, version gate), checks dedupe (same key → return existing row, no event), appends `effect.intent_recorded`. Standards: `01-source-code.md`, `03-errors-and-observability.md`. Verify: `pnpm exec vitest run packages/domain/test/state-kernel.test.ts` still green.
- [x] 1.4 Add `cancelEffectLate` command: refuses when row is undefined/tombstoned/already closed, otherwise appends `effect.cancel_recorded` and stamps `late_cancel_received:true`. Standards: `01-source-code.md`, `03-errors-and-observability.md`. Same verify command as 1.3.
- [x] 1.5 Extend `closeEffect`: if `late_cancel_received` is truthy, refuse with `forbidden:effect-cancelled` (atomic). Standards: `01-source-code.md`, `03-errors-and-observability.md`. Verify: `pnpm exec vitest run packages/domain/test/state-kernel.test.ts` (existing assertion behaviour).

## 2. Regression tests

- [x] 2.1 New test file `packages/domain/test/effect-ledger-intent-first.test.ts` — covers the five spec scenarios in `specs/project-state-kernel/spec.md`. Tests must name the scenario they're proving. Verify: `pnpm exec vitest run packages/domain/test/effect-ledger-intent-first.test.ts` (5/5 green).

## 3. Gate

- [x] 3.1 `pnpm validate` end-to-end green (format, build, lint, typecheck, boundaries, tests, coverage, openspec).
- [x] 3.2 `pnpm exec openspec validate effect-ledger-intent-first --strict` passes.
- [x] 3.3 Commit (Conventional Commit, concise English message), push, watch CI until green.
