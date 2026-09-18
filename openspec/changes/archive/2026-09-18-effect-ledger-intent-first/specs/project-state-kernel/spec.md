# Delta: project-state-kernel — effect ledger intent-first

## ADDED Requirements

### Requirement: the effect ledger is authoritative for side-effect facts

The kernel SHALL maintain the Effect Ledger as the single source of truth for side-effect facts: an effect is first recorded as **intent** (`recordEffectIntent` / `effect.intent_recorded`) BEFORE its executor runs against the outside world; replaying the same intent key SHALL return the already-recorded row with zero new events and zero new rows (idempotent intent admission); and a late cancellation SHALL be materialized via `cancelEffectLate` / `effect.cancel_recorded` as an atomic `unknown` state with `late_cancel_received` stamped on the row, never as silence or a single-fold rollback. Closure of a late-cancelled effect via `closeEffect` SHALL be rejected with `forbidden:effect-cancelled` (the failure is explicit, not silent absorption).

#### Scenario: intent is recorded before the effect runs

- **WHEN** a caller records an intent for an effect that has not yet run (no `effect.recorded` event exists yet)
- **THEN** the ledger contains one row in `unknown` status, the event log gains exactly one `effect.intent_recorded` event, and the subsequent `recordEffect` can transition it

#### Scenario: duplicate intent replay returns the same row without writing again

- **WHEN** a caller records an effect intent with intent key K
- **AND** records the same intent with intent key K again
- **THEN** the second call returns the same row id
- **AND** the total count of `effect.intent_recorded` events in the log is exactly one
- **AND** there is exactly one row in the ledger for that intent key

#### Scenario: late cancel is marked unknown, never rolled back

- **WHEN** an effect is already in a non-terminal state and `cancelEffectLate` is invoked
- **THEN** the ledger row is set to `unknown`
- **AND** `late_cancel_received` is stamped on the row
- **AND** the `effect.cancel_recorded` event is appended exactly once

#### Scenario: confirmed/failed after late cancel is refused

- **WHEN** an effect row carries `late_cancel_received=true`
- **AND** a caller attempts to close the effect with outcome `confirmed`
- **THEN** the kernel rejects with `forbidden:effect-cancelled`
- **AND** zero events are appended (the refusal is atomic)

#### Scenario: late cancel on already-closed effects is refused

- **WHEN** an effect is already in `confirmed` or `failed` status
- **AND** `cancelEffectLate` is invoked
- **THEN** the kernel rejects with `forbidden:effect-already-closed`
- **AND** no late_cancel_received attribute is stamped
