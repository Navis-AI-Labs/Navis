# Design: effect-ledger-persistence

## Problem

A crashed process cannot tell which effects still need to run. The projection in memory has an answer; a fresh kernel would have to reimplement it to recover. This change pins the question to a kernel API (`listPendingEffects`) so the answer is authoritative.

## Choice: read-predicate on the kernel, nothing else

Options evaluated:

1. **A separate `EffectLedgerPendingStore` port in `packages/domain/ports/` with its own PG adapter.** Rejected — it would be a _second_ source of truth for an application-level answer the kernel already owns. Domain holds the predicate; persistence just feeds the kernel its events back.
2. **`listPendingEffects()` on the kernel + a replay round-trip test.** Chosen — one line of logic, Zero new tables, zero new ports. The EventStore is already transactionally safe (DEC-0011-favored shape); the question is only the predicate that callers need.

## Invariants

| #   | Rest                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-1 | Pending ⇒ alive, `status === 'unknown'`. Not selected when status = confirmed/failed. A late-cancelled flag alone does not unset pendingness.                  |
| I-2 | Replay equivalency: `listPendingEffects(k)`.length === `listPendingEffects(ProjectStateKernel.fromEvents(k.events))`.length — this is the property test above. |
| I-3 | No state vtable mutation happens in this getter (read-only by constness).                                                                                      |

## Test Plan

| Layer       | Test                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain unit | `packages/domain/test/effect-ledger-persistence.test.ts` with the three spec scenarios covered                                                                   |
| Infra/PG    | `packages/infrastructure/test/postgres.effect-replay.test.ts` — write events via PG adapter, rebuild via `ProjectStateKernel.fromEvents`, assert the pending set |

## Task table

| #   | Task                                                  | Requirement                | Standards               | Verify                                                     |
| --- | ----------------------------------------------------- | -------------------------- | ----------------------- | ---------------------------------------------------------- |
| 1   | Add `listPendingEffects(): EffectRow[]` to the kernel | pending-effects precedence | 01-source-code          | `pnpm exec vitest run …/effect-ledger-persistence.test.ts` |
| 2   | Regression tests (domain)                             | spec scenarios             | 02-testing              | `pnpm exec vitest run …/effect-ledger-persistence.test.ts` |
| 3   | Replay round-trip integration test (PG)               | spec scenario 3            | 07-data-and-persistence | `pnpm --filter @navis/infrastructure test` (postgres path) |
| 4   | Gates: `pnpm validate` + openspec strict              | all                        | 11-ci-and-release       | full pipeline log                                          |
