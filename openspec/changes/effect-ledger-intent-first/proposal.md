# Proposal: effect-ledger-intent-first

## Why

The kernel records effects today only as post-factum observations: `record_effect` exists when the executor already touched the world, and the "unknown" value carries no binding to the _intent_ that caused it. That has two consequences the ledger itself must close:

1. **Duplicate execution without suppression.** A retried return or a re-driving run can call the effect executor twice with the same intent; the ledger cannot see that both calls are one business action until they are both written down.
2. **Late-cancel cannot be told apart from total absence.** When a cancel signal arrives _after_ the side effect has been executed, the ledger currently has no way to say "the effect ran, we saw it, but a cancel came later" — the effect is indistinguishable from one that never ran. That mixture is exactly what must not be silently absorbed into Delivery gating decisions.

The Effect Ledger must become intent-first: an effect intent is recorded **before** the executor runs the effect, and the ledger can prove it. Late cancellation is marked deterministically (no rollback, no data lies).

## What Changes

- New event type `effect.intent_recorded` plus a new command `recordEffectIntent` on the kernel: records an intent row (same ledger, `unknown` status) with the _intent key_ the caller supplies. Idempotency: replaying the same intent key returns the existing row — zero extra events, zero new rows.
- New command `cancelEffectLate` with event `effect.cancel_recorded`: marks a non-terminal effect `unknown` and stamps `late_cancel_received` on the row; `closeEffect` refuses a print (forbidden: `effect-cancelled`) when such a row is in a reviewed state that would fabricate confirmation.
- The existing `unknown` status remains the initial state of a bare `recordEffect` (post-factum path); this change only strengthens the guarantee, it does not break the existing API.
- Regression tests pin all three properties: intent-first ordering, idempotency of the intent record, and late-cancel finality.

## Non-Goals

- Executor-side idempotency: the actual `execute` call against the world is still the operator's / application layer's job.
- PostgreSQL persistence maturity and formal crash recovery semantics belong to a separate infrastructure change; this change only hardens the domain model.
- Versioning / rate limits / other policy changes that are not required by the intent-first contract itself.

## Capabilities

### Modified Capabilities

- `project-state-kernel`: Effect Ledger must be intent-first (no "effect recorded without intent"), idempotent on intent-key (same intent key = one row, zero extra events), and late-cancel must be a first-class observable, not-absorbable signal.

### New Capabilities

_None._

## Impact

- `packages/domain/src/state/project-state-kernel.ts`: +2 commands, +2 events. `packages/domain/test/`: one new regression file.
- No other packages touched; no schema/runtime changes beyond the new events and the intent-key uniqueness guard.
