# Delta: project-state-kernel — effect execution-recovery lifecycle

## MODIFIED Requirements

### Requirement: the effect ledger is authoritative for side-effect facts

The kernel SHALL maintain the Effect Ledger as the single source of truth for side-effect facts: an effect SHALL first be recorded as intent (`recordEffectIntent` / `effect.intent_recorded`) BEFORE its executor runs against the outside world; replaying the same intent key SHALL return the already-recorded row with zero new events and zero new rows; and a late cancellation SHALL be materialized via `cancelEffectLate` / `effect.cancel_recorded` without rolling anything back.

Beyond the E1 surface: the ledger SHALL distinguish "intent that has never been attempted" from "intent mid-execution" by elevating execution start to a real state, `executing`. Row closure SHALL be allowed only from `executing` (closing straight from `unknown` is rejected as `forbidden: effect-not-executing` — read: the ledger cannot bear a claim that an effect ran when no `effect.execution_begun` event exists). Stuck executors SHALL be drainable only through an explicit `resetEffectExecution` call, which returns the row to `unknown` and increments its `execution_attempts` counter (visible in the event payload as `attempts_next`).

#### Scenario: intent is recorded before the effect runs

- **WHEN** a caller records an intent for an effect that has not yet run (no `effect.intent_recorded` event exists yet)
- **THEN** the ledger contains one row in `unknown` status, the event log gains exactly one `effect.intent_recorded` event, and a subsequent begin transitions it cleanly

#### Scenario: duplicate intent replay returns the same row without writing again

- **WHEN** a caller records an effect intent with intent key K twice
- **THEN** the second call returns the same row id
- **AND** the log contains exactly one `effect.intent_recorded` and one row

#### Scenario: late cancel is marked unknown, never rolled back

- **WHEN** an effect is in `unknown` and `cancelEffectLate` fires
- **THEN** the row still shows `unknown` with `late_cancel_received: true` and exactly one `effect.cancel_recorded` event

#### Scenario: confirmed/failed after late cancel is refused

- **WHEN** an effect row carries `late_cancel_received=true`
- **AND** a caller attempts to close the effect with outcome `confirmed`
- **THEN** the kernel rejects with `forbidden:effect-cancelled` and appends nothing

#### Scenario: late cancel on already-closed effects is refused

- **WHEN** an effect is already in `confirmed` or `failed` and `cancelEffectLate` is called
- **THEN** the kernel rejects with `forbidden:effect-already-closed` and no `late_cancel_received` stamps

#### Scenario: intent can only begin once

- **WHEN** an effect row is in `unknown` status
- **AND** the actor calls `beginEffectExecution(effect_id)`
- **THEN** the row's status becomes `executing` and exactly one `effect.execution_begun` event is recorded
- **AND WHEN** the actor calls `beginEffectExecution` again
- **THEN** the kernel rejects with `forbidden`

#### Scenario: crash mid-execution is observable after replay

- **WHEN** an effect is `executing` and the executor process dies
- **AND** a rebuilt kernel replays the event log
- **THEN** the row appears in `listExecutingEffects()` (new read) with status `executing` and its original attempt metadata

#### Scenario: executors must reset before retry

- **WHEN** an executing effect's caller decides to retry
- **AND** the caller performs `resetEffectExecution(effect_id, reason)`
- **THEN** the row goes back to `unknown`, the `effect.execution_reset` event records `{ effect_id, reason, attempts_next }`, and `execution_attempts` increments by 1
- **AND** a later `beginEffectExecution` is now legal

#### Scenario: close from `unknown` is now rejected

- **WHEN** a caller calls `closeEffect` on a row that is still `unknown` (never begun)
- **THEN** the kernel returns `forbidden:effect-not-executing` and no `effect.closed` event is written
- **AND WHEN** the caller properly begins the effect first
- **THEN** the same close call succeeds

#### Scenario: executing + late cancel cannot quietly confirm

- **WHEN** an `executing` effect has `late_cancel_received: true`
- **AND** the executor tries to close with outcome `confirmed`
- **THEN** the result is `forbidden:effect-cancelled`
- **AND WHEN** the executor closes with `failed` instead
- **THEN** the row settles terminal in `failed`
