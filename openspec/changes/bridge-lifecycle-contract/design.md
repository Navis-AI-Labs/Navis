# Design: bridge-lifecycle-contract

## Problem

Nothing in the repository pins the Bridge's process-lifecycle semantics. R1 will add a real process (Unix socket) and it must obey a contract that has already been captured: single socket, single instance, exit detection, restart-with-new-pid. Waiting until R1 to decide these linearly changes what R1 looks like.

## Choice: domain-side pure port

The contract lives in `packages/domain/src/bridge/`, not in `packages/infrastructure`, because it is a _semantic_ contract, not an implementation choice. The in-memory adapter is what we hand to OpenSpec scenario tests and to R1 engineers as the reference for the wire-level adapter that will replace it.

## Invariants

| #   | Rules                                                                                             |
| --- | ------------------------------------------------------------------------------------------------- |
| I-1 | `ensureRunning` is idempotent within a process lifetime: same `pid`, `created: false`.            |
| I-2 | First positive `ensureRunning` on a _missing_ state returns `created: true` plus a fresh `pid`.   |
| I-3 | `onExit` fires exactly once per exit, then the next probe reports `'missing'`.                    |
| I-4 | A new spawn always gets a monotonically different attempt number — observed as a different `pid`. |

## Test plan

One unit-test file covers the four scenarios one per test:

`packages/domain/test/bridge-lifecycle.test.ts`

## Task table

| #   | Task                                                                                         | Requirement                   | Standards                       | Verify                                                                             |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Domain `BridgeLifetimePort` type + `InMemoryBridgeLifetime` in `packages/domain/src/bridge/` | bridge-lifecycle requirements | 01-source-code §36 (TSDoc ·why) | `pnpm --filter @navis/domain build`                                                |
| 2   | Unit tests per scenario (first-connect spawn, reuse, exit ordering, restart-after-exit)      | scenarios                     | 02-testing                      | `pnpm exec vitest run packages/domain/test/bridge-lifecycle.test.ts`               |
| 3   | Gates: prettier + build + test + openspec strict                                             | all                           | 11-ci-and-release               | `pnpm validate` + `pnpm exec openspec validate bridge-lifecycle-contract --strict` |
