# Proposal: work-lifecycle-closure

## Why

Two work-lifecycle gaps remain open in the project kernel, and both sit exactly on the contract between a human dispatch and an agent execution:

1. **Equip `active_holds` is project-wide noise.** Every issued equip currently lists every active hold in the project, regardless of which work the hold was registered during. An agent reading its equip cannot tell which holds are obligations on _its_ work and which are background, so the contract's blocking semantics are useless as a dispatch signal.
2. **A cancelled (or already-completed) work has no kernel-level start guard.** `startRun` today rejects only a missing or unalive record; a cancelled or completed work can start another run, silently resurrecting closed work and polluting the event log with runs that have no legitimate lifecycle claim.

Both are field-semantics and lifecycle-completion issues, not API reshaping. Closure keeps the contract truthful: an equip says "these holds block _this_ work", and "closed means closed" for works.

## What Changes

- Narrow `Equip.active_holds` derivation to holds with `status='active'` AND (`registered_during_work` equals the equip's `work_id` OR `registered_during_work` is unset/null — project-wide holds still apply to every work). `verified_facts` stays project-wide by design (assets have no per-work attribution field; narrowing it would be a fabrication).
- Add a kernel guard: `startRun` and `startRunFor` reject any target work whose status is `cancelled` or `completed` (or tombstoned), with the `forbidden` error and a `reason: 'work-closed'` detail; no event is appended.
- Pin both behaviors with dedicated kernel regression tests and spec scenarios.

## Capabilities

### Modified Capabilities

- `project-state-kernel` — requirement "equip is a derived contract carrying facts, holds, goal, criteria, and allowed effects": the active_holds derivation rule narrows as above; existing scenarios are preserved verbatim and new scenarios cover the work-bound vs project-wide split.
- `workrun-execution` — requirement "starting a run requires an equip issued at the current state version": extended with the work-closed guard (cancelled or completed works reject start, same `forbidden` error channel, no event).

## Non-Goals

- No change to `verified_facts` semantics — assets carry no per-work attribution field today, and inventing one here is a schema change forbidden by this change's scope.
- No hold-attribution backfill for historical holds: holds without `registered_during_work` are treated as project-wide (doubtful attribution means visible, never silently hidden).
- No change to the transition table, takeover flow, delivery gates, or any persistence schema — derivation logic only.
- No new public contract fields on the Equip shape — only the composition rule for an existing field changes.

## Impact

- `packages/domain/src/state/project-state-kernel.ts`: equip derivation filter (active_holds) + startRun/startRunFor guard.
- `packages/domain/test/`: new regression tests (work-scoped hold isolation; project-wide hold inheritance; cancelled/completed work start rejection).
- Downstream consumers (any read surface) inherit corrected semantics without their own filtering — that is the point of owning the rule in the kernel.
