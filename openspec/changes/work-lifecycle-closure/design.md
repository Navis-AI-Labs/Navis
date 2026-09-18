# Design: work-lifecycle-closure

## Overview

This change closes two lifecycle leaks in the project kernel without adding any new type, table, or transport surface. Both leaks live at the derivation boundary where internal state becomes an outward contract.

## Part 1 — Narrowing active_holds to the work

### The current mistake

The equip derivation selects holds by liveness and status only. Every active hold in the project enters every equip, whether or not it was registered during the work the equant concerns. As projects accumulate coordination holds (pauses for reasons unrelated to a given work), every downstream agent gets a bigger and bigger list of "holds" that do not block the work it was assigned to do. The contract then says, in effect, "everything is relevant to you", which is the same as saying nothing is.

### The rule

The derivation keeps the existing two filters (alive, status active) and adds a work-bound filter: a hold qualifies when its `registered_during_work` equals the equip's `work_id`, or when the field is null or undefined. The null-inclusive branch is deliberate: a hold that never names a work is a project-level hold and must still hold every work — hiding it would quietly drop obligations, which is worse than over-equipping.

### Why verified_facts does NOT follow

One may ask "if holds are narrowed per work, why not verified facts too?" The answer is schema reality: the asset table has no field naming the work the fact belongs to, so narrowing verified_facts per work would require either (a) a bogus heuristic (asset name similarity) or (b) a schema change (adding `work_id` to assets). Both lie outside this change. Fact visibility therefore stays at project scope by the existing scope predicate — per earlier settled capability design (spec already pins that rule).

### Where the rule lives

Exactly one place: inside the equip composition function in the project kernel. Consumer code (returns, worker-side digestion, future read surfaces) does not filter holds again — if it does, it will shadow the rule and this change has failed its purpose.

## Part 2 — Closed works cannot start runs

### The gap

`startRun` already rejects a missing or tombstoned work, and `startRunFor` does the same. What it does not reject is a work whose work status is `cancelled` or `completed`: those works remain visible, so a run can be minted against a closed obligation. The run exists, but the work it purports to advance has already exited its lifecycle; everything downstream (acceptance of its return, delivery of its artifact) inherits a lie from birth.

### The guard

Before any other start check (equip presence, foreign-equip, stale-equip), the kernel validates the target work: if the work is missing, tombstoned, completed, or cancelled, the command fails with the standard `forbidden` error, detail `work-closed`, and zero events appended. The same rule applies to both public start methods so rerouting around one of them cannot bypass it.

### Order-of-check question

The guard must run before equip checks and never after a successful one: a closed work cannot be "fixed" by a better equip. This makes the closed-work rejection deterministic regardless of how stale the caller's references are — a stale-equip rejection and a closed-work rejection must never race to different outcomes depending on evaluation order, so closed-work is checked first, unconditionally.

## Migration and rollback

- **Migration**: none. No schema or persisted event format changes: existing `registered_during_work` values are untouched, and existing runs/works are not rewritten. Holds that predated the field keep null and remain project-visible, which is the deliberate conservative default.
- **Rollback**: revert the kernel diff. The narrowed derivation and the closed-work guard are pure read-time/gate-time logic; reverting restores prior observable behavior without reconciling any persisted state. The only consumer risk is that prior callers saw MORE holds; reverting to that behavior is a behavioral widening, never a correctness hazard.

## Alternatives considered (and why not)

- Splitting the equip into two hold fields (work-scoped vs project-wide): rejected because it degrades the single contract field into two that must stay consistent forever; the derivation rule answers both audiences with one well-defined membership test.
- Doing the closed-work guard in the API layer instead of the kernel: rejected because every current and future execution path (Bridge-triggered runs, future worker-triggered starts) must be bound by the same rule; only the kernel is everywhere.
