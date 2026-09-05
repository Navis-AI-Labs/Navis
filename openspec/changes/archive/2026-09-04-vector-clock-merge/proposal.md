# Proposal: vector-clock-merge

## Why

An agent that works offline can produce output while the project state moves forward without it. Today the run lifecycle is one-directional: the kernel accepts or rejects a completion against a single linear expectation, so an offline branch's work is either silently ordered after changes it never observed or blocked without a principled verdict. Bidirectional merge requires causal metadata that can distinguish "happened after" from "happened in parallel" — a distinction no revision counter can make.

## What Changes

- Introduce a pure vector-clock module in the domain: four-state comparison (`dominates`, `dominated_by`, `concurrent`, `equal`), per-participant monotonic components, merge (component-wise max), and snapshot serialization carried alongside kernel rows.
- Introduce a pure vector-clock module in the domain: four-state comparison (`dominates`, `dominated_by`, `concurrent`, `equal`), per-participant monotonic components, merge (component-wise max), and snapshot serialization carried alongside kernel rows.
- Extend the return submission (`submitReturn`) to accept a `causal_context` clock snapshot from the caller; the kernel compares it against the project's authoritative clock and records the verdict on the return event (`return.absorbed` or `return.rejected`).
- When the verdict is `concurrent` and the return is otherwise absorbable, the kernel appends a conflict-marking event that routes the returned candidates into human acceptance review instead of letting either side silently dominate; the review outcome flows through the existing acceptance commands.
- Grow the project's authoritative clock monotonically: every accepted event records the acting participant and advances that participant's component (per-actor monotonicity).
- Require clock bootstrap for participants: equip issuance stamps the equip with the authoritative clock snapshot at the equip's state version, so retired-participant knowledge stays symmetric.
- Retire clock components only for departed participants, only when the component is unanimous across all live knowledge holders (including the server), and only atomically.
- Keep the decision surface honest: the clock records concurrent-versus-ordered; what to do with marked candidates is decided only by the existing human acceptance commands.
- Reject automatic merging of any kind: the clock only detects; humans resolve.

## Capabilities

### New Capabilities

- `bidirectional-merge`: causal-clock semantics (four-state comparison, monotonic components, equip-carried bootstrap, retirement constraints) and the conflict-marking of concurrently produced returns into the existing human acceptance flow.

### Modified Capabilities

- `project-state-kernel`: the return submission accepts an optional `causal_context`, records the comparison verdict on the return event, and appends a conflict-marking event on `concurrent`; the equip gains a bootstrap clock snapshot. (The existing return, equip, and acceptance requirements are extended in place — the delta spec adds requirements to this capability's folder.)

## Impact

- `packages/domain`: new vector-clock module; `submitReturn` comparison path, project clock persistence on the project row, one new event type, new error codes.
- `packages/domain/src/schema`: `causal_context` on the return command payload; clock snapshot schema on the project row and the equip.
- `packages/infrastructure`: migration for the project clock column (new migration file; no edits to existing migrations), wire-level test updates, in-memory store passthrough.
- Standards in force: `01-source-code`, `02-testing`, `06-contracts-and-compatibility`, `07-data-and-persistence`, `08-concurrency-and-reliability`.
- ADRs to draft: causal metadata mechanism selection (vector clock vs alternatives) and component-retirement safety constraints.
- Non-goals: no CRDT or automatic merge; no checkpoint-context rebuild beyond the existing checkpoint reference; no multi-project or cross-shard clocks; no schema-generation or bridge changes.
