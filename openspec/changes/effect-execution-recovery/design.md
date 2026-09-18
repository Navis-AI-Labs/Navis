# Design: effect-execution-recovery

## Problem

A kernel rebuilt after a crash cannot tell whether an `unknown` effect row was (a) created and never attempted or (b) handed to an executor that died before closing. These two cases demand opposite handling: (a) wants re-execution, (b) wants no silent re-execution.

## Choice: introduce `executing` as a real state

Effect lifecycle becomes:

```
unknown  --(beginEffectExecution)-->  executing --(closeEffect)--> confirmed | failed
   ^                                     |
   +-----(resetEffectExecution)----------+
```

Transitions and rules:

| Transition | Guard                                                                        | Event                    | Payload                                |
| ---------- | ---------------------------------------------------------------------------- | ------------------------ | -------------------------------------- |
| begin      | from `unknown` only (once)                                                   | `effect.execution_begun` | `{ effect_id }`                        |
| close      | from `executing` only; ties `late_cancel_received` to refusal of `confirmed` | `effect.closed`          | existing payload                       |
| reset      | from `executing` only, with reason                                           | `effect.execution_reset` | `{ effect_id, reason, attempts_next }` |

`execution_attempts` on the row increments on every reset, staying monotonic across lifecycle epochs.

`listPendingEffects()` remains `status === 'unknown'` (never-attempted). New `listExecutingEffects()` returns the stuck-execution set — the only candidates a recovery runner may safely have a look at; the runner then calls `resetEffectExecution` (an explicit, audited act) before re-driving.

`cancelEffectLate` retains its E1 semantics on rows in any non-terminal state, including `executing` — a late cancel may arrive while the executor is mid-flight and still marks the row; close will not then emit `confirmed`.

`closeEffect` from `unknown` changes semantics: direct closing of never-attempted intents is no longer legal (it was ambiguous between "already ran + confirmed" and "never ran"). Callers migrating from the old shape add a begin first. Per the project's no-backward-compatibility stance, we change the guard bluntly and update the 21 E1 tests accordingly.

## Schema additions (event vocabulary)

- `effect.execution_begun`: `{ effect_id }`
- `effect.execution_reset`: `{ effect_id, reason, attempts_next }`

Both go through the replay `applyEvent` cases in the kernel (structured events replay like every other row).

## Test plan

| Suite                                         | Case it pins                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `effect-execution-recovery.test.ts` (new)     | spec scenarios one each; replay from events; reset increments `execution_attempts` |
| `effect-ledger-intent-first.test.ts` (update) | `closeEffect` paths first call `beginEffectExecution`                              |
| `work-effect-*` / `state-workrun`             | any post-factum `closeEffect` inserts going through intent path                    |

## Task table

| #   | Task                                                                                                   | Requirement         | Standards         | Verify                              |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------- | ----------------- | ----------------------------------- |
| 1   | Extend `EffectRow` (status `executing`, `execution_attempts`) + event schemas + kernel replay switches | delta scenario list | 01-source-code    | `pnpm --filter @navis/domain build` |
| 2   | Implement `beginEffectExecution` / `resetEffectExecution` / tightened `closeEffect`                    | same                | same              | same                                |
| 3   | Update regression suites (all old close paths begin first) + new suite for crash-recovery paths        | scenario tests      | 02-testing        | `pnpm run test:coverage`            |
| 4   | Gates (`pnpm validate`, openspec strict, CI)                                                           | n/a                 | 11-ci-and-release | full pipeline green                 |
