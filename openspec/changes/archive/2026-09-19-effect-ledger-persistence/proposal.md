# Proposal: effect-ledger-persistence

## Why

The kernel records effect intents and late-cancel signals as events (`effect.intent_recorded`, `effect.cancel_recorded`, `effect.closed`), and the generic `PostgresEventStore` already persists every event transactionally. What it does not answer operationally is: **after a crash, which effects still need their side effect to be executed or re-confirmed?** Today the only way to learn that is to replay the whole ledger into memory and eyeball rows. A recovery flow needs an authoritative, testable answer in one call.

Without this, the R0 acceptance criterion "persist + crash recovery: a completed intent is not re-executed after a crash, a pending intent is recoverable" cannot be wired end-to-end (it is an integration-tested acceptance line, not just a data property).

## What Changes

- Kernel: new read-only method `listPendingEffects(): EffectRow[]` — returns all alive effects with status `unknown` (no filter on late_cancel_received: a late-cancelled row in `unknown` still needs confirmation, it is NOT final).
- Infrastructure (Postgres adapter): no new table. The recovery path rides the existing append + snapshot machinery; the new guarantee comes from a PG-backed integration test asserting persistence round-trip for every event kind we have added.
- Test contract: replay from PG store after process-abort yields the same pending list as a live kernel.

## Why (again, operational terms)

Without this listed predicate, "the project rebooted" is indistinguishable from "nothing happened before the crash" — the two cannot be told apart when a Worker asks "should I re-drive the executor?". This change makes them distinguishable.

## Non-Goals

- Executor-side idempotency of the effect payload itself (that is baton at R0-48 in the roadmap's numbering).
- Recovery scheduling / worker trigger: this change exposes the signal; it does not run the poller.
- Command-intake integration: the command inbox / dispatchCommand flow already exists and is unaffected.

## Capabilities

### Modified Capabilities

- `project-state-kernel`: adds one read predicate for effect-ledger pending recovery; no behavioral change to any command path.
- `persistence-ports`: documents that effect-ledger crash recovery is implemented _at_ the EventStore + kernel boundary (the port scope did not promise it until now).

## Impact

- `packages/domain/src/state/project-state-kernel.ts`: +1 method, ~10 lines.
- `packages/domain/test/effect-ledger-intent-first.test.ts` (or a new dedicated persistence test file):
  - listPendingEffects returns only unknown rows;
  - closed rows drop out;
  - late-cancelled unknown rows stay listed (they are still pending confirmation).
- `packages/infrastructure/test/`: one PG-backed replay integration test proving kernel state survives process restart with the same effect rows.
- OpenSpec strict + full `pnpm validate` green on commit+push.
