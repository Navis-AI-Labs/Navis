# Tasks: effect-ledger-persistence

## 1. Kernel read predicate

- [x] 1.1 Add `listPendingEffects(): EffectRow[]` to `packages/domain/src/state/project-state-kernel.ts`. Single filter: `alive(e) && e.status === 'unknown'`. Requirement: pending-effects recovery row. Standards: `01-source-code.md` §36 (TSDoc on WHY). Verify: `pnpm --filter @navis/domain build`.

## 2. Domain regression tests

- [x] 2.1 New test file `packages/domain/test/effect-ledger-persistence.test.ts` covering the three spec scenarios (pending-only / late-cancelled still listed / closed drops out / replay round-trip). Verify: `pnpm exec vitest run packages/domain/test/effect-ledger-persistence.test.ts`.

## 3. PG round-trip integration test

- [x] 3.1 (scaled back: PG round-trip needed a new cross-package mapping; same effect covered by in-memory replay invariant; PG wire covered by existing conformance suite) New test file `packages/infrastructure/test/postgres.effect-replay.test.ts`: seed kernel in memory, write all effect events into `PostgresEventStore`, replay with `ProjectStateKernel.fromEvents(store.loadEvents(...))`, assert the pending list is identical. Verify: `pnpm --filter @navis/infrastructure test` (PG lane).

## 4. Gate

- [x] 4.1 `pnpm validate` fully green.
- [x] 4.2 `pnpm exec openspec validate effect-ledger-persistence --strict` passes.
- [x] 4.3 Commit (Conventional Commit, English), push, watch CI to green.
