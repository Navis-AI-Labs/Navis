# Design: effect-ledger-intent-first

## Context

The kernel today exposes `recordEffect` (post-factum: after the executor already touched the world) and `closeEffect` (close unknown → confirmed/failed). The ledger shape is `Record<string, EffectRow>` keyed by effect id. Effect-event vocabulary: `effect.recorded`, `effect.closed`.

This ledger requires **intent-first**: the intent must land on the ledger before the executor runs. It also requires **late-cancel as unknown**: a cancel signal that arrives after the side effect ran folds the row to unknown without silencing it or rolling it back.

## Decision: extend the existing ledger, don't build a new layer

Evaluated options:

1. **New "Intent Ledger" subsystem alongside the ledger.** Rejected — it doubles the surface, breaks the single-predicate audit story, and forces readers to query two collections to answer one business question.
2. **Extend the same ledger with `intent_key` and `late_cancel_received` fields plus two more commands.** Chosen — DRY on EffectRow, the ledger remains one authoritative document, and commands stay thin. The choice costs some optional fields on an existing row type; that cost is stated here.

The chosen option keeps the same shape of truth ("one effect, one row"), and the same gate rule that blocks storage/delivery decisions against unclosed unknown effects now also blocks against rows with outstanding de-duplication checks.

## Design

### Schema changes (packages/domain)

- `EffectRow` gains:
  - `intent_key?: string` — caller-supplied dedupe key (unique across the ledger when set; absent = the row was written only via the legacy post-factum path)
  - `late_cancel_received?: boolean` — stamped only when `cancelEffectLate` accepts the cancel
- Zod schema for `EffectRow` is adjusted in one place (the projection schema); `EventPayload` gains `effect.intent_recorded` and `effect.cancel_recorded`; both become part of the single-events vocabulary list.

### Commands

- `recordEffectIntent({actor, at, intent_key, asset_ref?, description?, expected_version})`: if a row with `intent_key` exists → return it (no event appended). Otherwise append `effect.intent_recorded { effect_id: new uuid v7, intent_key, actor, ... }` and return the row. The new row's initial status is `unknown` (consistent with existing semantics of "the ledger holds claims that have not yet been confirmed").
- `cancelEffectLate({actor, at, effect_id, reason, expected_version})`: refuses when the row is missing/tombstoned (`effect-not-found`), already closed (`confirm`/`failed` → `effect-already-closed`), or already late-cancelled (`effect-already-late-cancelled`). Otherwise appends `effect.cancel_recorded { effect_id, actor, reason }`, sets the row's `late_cancel_received`; the row's status becomes `unknown` (it was already unknown; no change is required).
- `closeEffect` grows a guard: if `late_cancel_received` is true, refuse with `forbidden:effect-cancelled` — a late cancel can never become "confirmed" later; that guarantees the invariant that cancelling never silently upgrades to success.

### Where the code lives

- New command types, validation tuples, and guard branches: `packages/domain/src/state/project-state-kernel.ts` (same module, no new file — single-owner rule).
- Event vocabulary additions: `packages/domain/src/state/event-vocabulary.ts` (adding two strongly-typed events).
- No changes to tests outside the new regression file; existing 675 tests must keep passing verbatim (spec change extends the surface, doesn't break earlier promises).

### Standards applicable (from `docs/standards/00-index.md`)

| Standard                            | Why it applies                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `01-source-code.md`                 | variants exhaustive, immutability, no narrating-code comments                     |
| `02-testing.md`                     | 3 positive + 2 negative regression tests with purpose-named describes             |
| `03-errors-and-observability.md`    | `forbidden:effect-cancelled` error carries domain-stable code, no stack exposure  |
| `05-documentation.md`               | TSDoc on the two new commands explains only the invariant and why it is needed    |
| `08-concurrency-and-reliability.md` | idempotency (`intent_key` unique) is explicit and replayable; no implicit retries |

### Failure modes and policy

| Failure                                              | Behavior                                               |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `recordEffectIntent` called twice with same key      | returns same row, zero extra events (idempotent)       |
| `cancelEffectLate` on closed/terminal row            | forbidden `effect-already-closed`                      |
| `closeEffect` on late-cancelled row                  | forbidden `effect-cancelled`                           |
| Missing/invalid version on any of the three commands | existing preconditions gate handles it (no new policy) |

### What stays unchanged

- `recordEffect` (post-factum path) semantics and signature.
- `closeEffect` normal-phase behavior.
- Delivery gate rule: unknown effects block, closed effects don't (this change preserves that semantic).
- The read surface (baton A2) — it does not yet expose the ledger; this change does not need to.
