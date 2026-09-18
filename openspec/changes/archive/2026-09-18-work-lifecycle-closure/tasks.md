# Tasks: work-lifecycle-closure

## 1. Kernel — active_holds narrowing

- [x] 1.1 `packages/domain/src/state/project-state-kernel.ts`: in the issued-equip derivation, filter `active_holds` to holds with `status === 'active'` AND (`registered_during_work === equipWorkId` OR `registered_during_work === undefined`); keep every other derivation input untouched. Requirement: equip is a derived contract carrying facts, holds, goal, criteria, and allowed effects. Standards: `docs/standards/00-index.md` (all standards selected for domain change). Verify: `pnpm --filter @navis/domain test`.
- [x] 1.2 Add kernel unit test: two works W1/W2 in one project; hold A registered during W1, hold B unbound (project-wide); equip for W1 carries exactly {A, B}; equip for W2 carries exactly {B}. Verify: `pnpm --filter @navis/domain test -- --run -t "equip carries current facts"` plus new test file run.
- [x] 1.3 Add kernel unit test: with zero work-matching holds and one project-wide hold, equip.active_holds has length 1 (fail-fast against accidental exclusion of project-wide holds).

## 2. Kernel — closed-work start guard

- [x] 2.1 In `startRun` and any other run-start entry point (e.g. `startRunFor`), pre-check the target work: missing / tombstoned / `status in {cancelled, completed}` → reject with `forbidden`, `details.reason = 'work-closed'`, append zero events. Requirement: starting a run requires an equip issued at the current state version. Verify: `pnpm --filter @navis/domain test`.
- [x] 2.2 Regression test: cancel a work, then attempt `startRun` with a perfectly valid (current-version, participant-owned) equip — must still be rejected. Verify: `pnpm --filter @navis/domain test`.
- [x] 2.3 Regression test: complete a work, then attempt `startRun` — must reject identically. Verify: same command.

## 3. Gate

- [x] 3.1 `pnpm validate` all green (format/build/lint/typecheck/boundaries/test/openspec strict).
- [x] 3.2 `pnpm exec openspec validate work-lifecycle-closure --strict` passes.
- [x] 3.3 Re-verify that no other file in the repo filters equip holds by work id (rule stays single-owner): `grep -rn "registered_during_work" packages/ --include="*.ts"` returns only kernel/derivation + test sites.
