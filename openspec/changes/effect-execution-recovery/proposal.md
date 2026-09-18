# Proposal: effect-execution-recovery

## Why

The ledger records intent (R0-45), late cancel (R0-46), and pending recovery (R0-47), but it cannot tell "this effect was never attempted" apart from "this effect was attempted and then the process died before closure". That distinction is the entire point of the crash-recovery gate: an attempted-but-unclosed effect MUST NOT be re-executed by a runner that doesn't know whether the side effect already landed.

Without a visible `executing` marker, every recovery runner has to guess. Guessing duplicates externally-observable side effects.

## What Changes

- Domain:
  - New command `beginEffectExecution` → unknown rows move to new status `executing` and emit `effect.execution_begun`. Exactly once per effect; late-cancelled rows may still enter (the runtime then drives the executor so the cancel becomes visible inside the side-effect completion).
  - `closeEffect(id, outcome)` — only valid from `executing`. (Changed: closing directly from `unknown` is no longer allowed — a caller must first `beginEffectExecution`. This pins the lifecycle in one direction and never weakens.)
  - `resetEffectExecution(reason)` → `executing` rows fall back to `unknown`, stamped with a _bounded_ attempts counter (`execution_attempts += 1`, event `effect.execution_reset`). `unknown` reset → forbidden.
  - `EffectRow` adds optional `execution_attempts: number`.
  - `listPendingEffects()` stays pure (`unknown` only). New read `listExecutingEffects()` returns alive rows in the mid-execution window (recovery would loop over this).
  - `closeEffect` rejects an `executing` row whose `late_cancel_received` is true — cancellation does not give the executor a silent confirm path.
- Schema event payloads: `effect.execution_begun { effect_id }`, `effect.execution_reset { effect_id, reason, attempts_next }`.
- All of this is covered by tests; nothing else changes shape.

## Why

Runners need an observable state machine so they can (a) refuse to re-drive a stuck `executing` row until an external breaker (operator or policy) has explicitly reset it, and (b) guarantee that even a "crash" produces a terminal event either on the ledger (`effect.execution_reset`) or as a terminal close (`closeEffect`).

## Non-Goals

- Executor job scheduler: this change provides the kernel API only.
- Putting the entire flow in a single PG transaction (already true from the append side; the real crash happens _in_ the executor — that is captured by `executing`).
- Retry policy UI.

## Capabilities

### Modified Capabilities

- `project-state-kernel`: effect ledger lifecycle — extend the states with `executing`, introduce the begun/reset events, close now requires `executing`.

## Impact

- `packages/domain/src/state/event-data.ts` + `effect-ledger-persistence` test file: +1 new scenario file.
- Previously 21 intent-first tests break (all closed from unknown); each needs a `beginEffectExecution` step. Update once.
- OpenSpec strict sweep, all gates green.
