# Design: vector-clock-merge

## Context

The kernel's run completion is judged against linear expectations (`run_revision`, `project_state_version`), which cannot distinguish "this work happened after those changes" from "this work happened in parallel with them". The proposal adds causal metadata (a per-project vector clock) so a completion can carry what its author observed, and the kernel can record an honest verdict.

Constraints inherited from the adopted baseline: the kernel is the only writer of project state; event types and error codes are closed, add-only registries; no Worker, transport, or runtime exists at this stage; the repository is self-contained; JSONB payload shapes are authored in the domain schema layer (`packages/domain/src/schema`), which is the vocabulary authority.

Standards selected for this change (per `docs/standards/00-index.md`): `01-source-code` (always), `02-testing`, `06-contracts-and-compatibility`, `07-data-and-persistence`, `08-concurrency-and-reliability`.

## Goals / Non-Goals

**Goals:**

- A pure, dependency-free clock module: compare (four verdicts), merge (component-wise max), snapshot serialization.
- An authoritative per-project clock maintained by the kernel and advanced by event authors.
- Return-time comparison: the verdict recorded on the return event and a conflict-marking event for `concurrent` absorptions.
- Bootstrap: equip issuance stamps the authoritative snapshot so participants start from shared knowledge.
- Retirement safety semantics enforced by construction (default-0 comparison, atomic single-row writes), ready for a future executor.

**Non-Goals:**

- No CRDT, no automatic merge or content reconciliation.
- No participant-departure lifecycle (retirement executor ships with participant lifecycle management in a later change; this change ships the safety semantics the executor must satisfy).
- No semantic contradiction detection (the contradictory axis of the decision matrix is a human/semantic-layer judgment, not a clock one).
- No cross-project, cross-shard, or wall-clock time components.
- No transport, UI, or Bridge changes.

## Decisions

### D1 — Causal metadata mechanism: classic vector clock

Chosen: per-participant counter map, four-state comparison, component-wise max merge.

Alternatives rejected:

- **Epoch / scalar counters** — cannot detect concurrency at all; two parallel branches are silently ordered by magnitude, which is exactly the data-loss this change exists to prevent. Wall-clock hybrids inherit the same ordering-only semantics plus clock-skew trust problems.
- **CRDT merge** — forbidden by the accepted baseline: conflicts route to human review; automatic reconciliation would bypass the human acceptance chain.
- **Dotted version vectors** — more precise conflict context per event, at the cost of a second metadata axis; unnecessary while components are keyed by participant and conflicts route to review rather than auto-resolution.

Evidence: the selection and the retirement constraints were validated with a property-based benchmark using an independent causal oracle (per-source event counters) across correctness, scale (thousand-participant, turnover, automated-worker storm), and deployment-topology scenarios; the ADR will record the method and results.

### D2 — Clock ownership and storage: a replayable projection on the project row

The authoritative clock lives as a single JSONB column (`causal_clock`) on the `projects` table, written in the same transaction as every event append. It is semantically a **replayed read cache**: the clock is derivable in full from the event history (author of each event), so `rebuildProjection()` reconstructs it; the column follows the same convention as other mutable projection tables. The column ships inside the base migration: no databases are deployed, so the schema baseline is rebuilt wholesale; the checksum guard still protects applied migrations from future edits.

Alternatives: a separate one-row-per-project table (extra join for zero benefit at one row per project); event-sourced-only (no materialized clock) (every comparison would replay — O(n) on the hot path).

### D3 — Snapshot shape and carriers

One schema, two carriers: `causalClockSnapshotSchema` = record of participant UUID → positive integer, with unknown keys rejected and values bounded to safe-integer range. Missing components compare as 0.

- **Command carrier**: the `submitReturn` command gains optional `causal_context` (same schema). Absent = legacy behavior, no verdict recorded (compatibility scenario pins this). The return's existing equip anchoring is unchanged: a return must still present a current equip or it is rejected wholesale before any clock judgment matters; the verdict is recorded on `return.rejected` even then, because the dispute facts are worth the ledger's memory. Schema authoring note from the audit: `SubmitReturnCommand`/`ReturnCandidateSeed` are TypeScript interfaces living beside the kernel, while transport-facing JSONB vocabulary is zod in `src/schema` (the `workrun.ts` `run_revision` precedent); this change adds `causalClockSnapshotSchema` as zod in `src/schema` and references it from both the kernel interfaces and the equip schema.
- **Bootstrap carrier**: the equip gains a `causal_snapshot` field stamped at issue time with the authoritative snapshot at the equip's state version. The equip is already the agent's authority contract anchored to a state version; a second bootstrap channel would fork the truth.

Authoritative-clock advances: the kernel's single central `append` method (one insertion point, 31 call sites) advances the acting participant's component by exactly 1 per accepted event (all event kinds — the clock measures observed activity, not only transitions). The clock advance rides the existing draft-mutation step inside `append`, so replay (`rebuildProjection`, which re-applies every event type through the same path) reconstructs it identically. Two audited nuances: `participant.registered` is the only null-actor event and advances nobody (its subject joins the clock from its own next action), and the kernel's `guardPreconditions` already rejects unregistered actors before append — the `causal-actor-unregistered` code is therefore a defensive depth for the direct-append edge, not the primary gate.

### D4 — Conflict marking: one new event type, payload records the dispute, resolution is existing machinery

New event type in the add-only registry: `return.conflict_marked` (naming follows the existing vocabulary: dotted namespace + underscore tail, cf. `equip.budget_exceeded`). Payload: verdict, the caller snapshot, the authoritative snapshot at comparison time. Ordering: appended immediately after the `return.absorbed` event, same transaction. The return itself absorbs as before; what the verdict gates is the acceptance path: absorbed candidates stay unaccepted until the existing human acceptance commands resolve them. No new resolution command is introduced — "AI proposes, humans enact" already owns the resolution surface (`acceptance.recorded`).

New error tokens (add-only registry): `causal-context-invalid` (malformed snapshot), `causal-actor-unregistered` (component key is not a registered participant). The registry is a single kernel-module, literal-keyed token map (`kernelErrorTokens`) whose keys are bare kebab tokens resolving to `kernel/<token>` URNs — these tokens join it as bare keys, exactly like the existing nine, with no slash namespaces.

### D4b — Multi-party parallel returns are first-class

The owner's review raised the branch-parallel analogy (multiple development lines like Git branches): in Navis this is N participants returning from mutually unaware offline work, not named branch objects. There is no branch aggregate to merge — each return is judged at its own judgment time against the then-authoritative clock, so two near-simultaneous parallel returns each earn their own conflict marking, and a later return whose snapshot already includes an earlier participant's return events is judged accordingly. Component-wise comparison makes N-way divergence a non-feature (no new mechanism beyond the pairwise verdict); the corresponding requirement and scenarios were added to the `bidirectional-merge` spec.

### D5 — Verification mapping

| Spec requirement                             | Verification                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Four-verdict comparison (mirror, self-equal) | Domain unit tests over generated snapshot pairs incl. property: mirror-consistency, self-equality                                              |
| Monotonic advance, unregistered actor        | Kernel tests: per-event component delta read-back; rejected command leaves clock untouched; replay-rebuild equality                            |
| Concurrent vs ordered return paths           | Kernel tests: verdict on `return.absorbed`/`return.rejected` payloads; `return.conflict_marked` presence/absence; candidates remain unaccepted |
| Legacy return unchanged                      | Kernel test: no `causal_context` → event payload shape identical to current baseline                                                           |
| Malformed context rejected                   | Kernel test: registry `causal-context-invalid`, nothing appended                                                                               |
| Equip bootstrap snapshot                     | Kernel test: issued equip carries snapshot matching its state version                                                                          |
| Retirement safety semantics                  | Domain tests: default-0 comparison; JSONB single-row write atomicity is asserted at the wire level (column exists, single UPDATE)              |
| SQL shape                                    | Wire-level migration test (new column, type, nullability)                                                                                      |

Gate: `pnpm validate` full suite; coverage thresholds unchanged (100% statements on touched code).

### ADRs to draft in this change

- ADR: causal metadata mechanism selection (D1, with benchmark evidence).
- ADR: clock component retirement safety constraints (unanimity, atomicity, join bootstrap prerequisite).

## Risks / Trade-offs

- [Snapshot size grows with participants] → Components only exist for participants who acted; benchmark at thousand-participant scale keeps snapshots in the low-KB range; retirement executor later bounds steady state to active participants.
- [Clients may send stale or partial snapshots] → By design: staleness is the point. The verdict reflects what the caller observed; `concurrent` routes to review, and `missing = 0` keeps partial snapshots comparable.
- [Every event advances the clock — extra write cost on hot path] → One JSONB column update inside the existing append transaction; no extra round trips.
- [Conflict events could accumulate] → They record disputes, which is the product intent; review outcomes flow through existing commands; no new retention policy needed at this stage.
- [Retirement executor deferred] → Guards ship now (default-0 semantics, atomic single-row writes); the future executor must satisfy the unanimity/atomicity/bootstrap prerequisites recorded in the spec and ADR.

## Migration Plan

1. The `projects` table gains a nullable `causal_clock` JSONB column, merged directly into the base migration: the repository has no deployed databases, so the schema baseline is rebuilt wholesale rather than carrying a change-only migration forward. The checksum guard still protects every future change against editing applied files.
2. `rebuildProjection()` initializes and replays the clock from event authorship; existing events (all having actor participants) backfill identical state.
3. Rollback: drop the column and remove the command field; no behavioral dependency exists until callers opt in by sending `causal_context`.

## Open Questions

- None blocking. The retirement executor's trigger (participant lifecycle command) is deliberately deferred and recorded as a non-goal.
