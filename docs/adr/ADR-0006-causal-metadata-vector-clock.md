# ADR-0006: Causal metadata via vector clock

- Status: Proposed
- Date: 2026-09-04

## Context

The project's return verdict is one-directional: a return is accepted or
rejected against a single linear expectation (the state version), so the
kernel cannot say whether an offline agent's work happened _after_ the
observed world, _in parallel_ to it, or _before_ it silently ordered both.
Boundary changes deliberately invalidate older equips (a direction change
must not be silently executed against an old plan), but the far larger
share of collaboration events — asset creation, run transitions, effect
recording — does not move the state version at all. Work that raced those
events is absorbed today with no record that parallelism happened.

Resolving this needs causal metadata that can distinguish "happened
after" from "happened in parallel" — a distinction no revision counter
can make. A property-based benchmark with an independent causal oracle
(correctness matrix across legitimate offline variants, adversarial
pruning attacks, 1000-participant scale, dual-region replication, and a
bot storm at 1200 events) compared four candidate mechanisms; the
epoch/scalar family failed structurally (two parallel branches are
ordered by magnitude — exactly the misjudgment the mechanism exists to
prevent), and CRDT-style content merge is out of scope by law (the
machine proposes; only humans accept, reject, or discard content).

## Proposed decision

1. A per-project causal clock in classic vector-clock form: a map from
   registered participant id to the count of that participant's events
   the holder has observed. Comparison yields exactly one of four
   verdicts (dominates, dominated_by, concurrent, equal); a component
   missing from a snapshot compares as zero.
2. The kernel owns one authoritative instance, advanced by the single
   central event-append path (one component per accepted event, keyed by
   registered actor; the null-actor registration event advances nobody).
   It is a replayable read cache on the project row
   (`projects.causal_clock`, jsonb) — reconstructible in full from event
   authorship, verified by replay-equality tests, never a second source
   of truth.
3. Snapshots travel on existing carriers only: an optional
   `causal_context` on the return command (validated against the governed
   schema, malformed rejected with `causal-context-invalid`, unknown
   participants with `causal-actor-unregistered`), and a `causal_snapshot`
   stamped on issued equips (bootstrap — a joiner starts from the
   authoritative observation, not from nothing).
4. A concurrent, otherwise-absorbable return is marked for human review
   by a `return.conflict_marked` event in the same transaction; its
   candidates remain unaccepted. The clock detects and remembers — it
   never merges, ranks, or decides. Verdicts on wholesale-rejected
   returns are recorded too: the dispute facts are worth the ledger's
   memory.
5. Absent `causal_context`, behavior is byte-identical to the
   pre-change baseline (pinned by a payload-shape test).

## Consequences

- Parallel work becomes visible, markable, and auditable for the first
  time; human review of a marked return sees both snapshots and can
  locate the divergence window from the recorded counters.
- The clock grows with the number of participants who ever acted.
  Benchmark results: per-compare cost stays in single-digit
  microseconds at 1000 participants; growth is strictly linear in
  events observed; no accumulation under adversarial event storms.
- Every accepted event now performs one extra map update — measured
  noise at kernel event rates.
- Callers that never send `causal_context` see no change; adoption is
  per-call, not per-deployment.

## Alternatives

- **Epoch / scalar / hybrid wall-clock counters:** rejected — they
  order, they cannot detect concurrency; a hybrid sealing scheme needs
  a global sync point that never fires under churn.
- **CRDT content merge:** rejected by law — automatic content
  reconciliation is a machine decision; the human acceptance chain owns
  every state consequence of a verdict.
- **Dotted version vectors:** rejected for R0 — their extra per-item
  dimension buys nothing until per-asset causality (a later capability)
  needs it; the participant-granularity clock carries the same verdict
  semantics at lower complexity.
- **No metadata, keep one-way rejection:** rejected — it is the
  bug this change exists to fix; parallel work stays invisible and
  offline branches get no principled verdict at all.

## References

- OpenSpec change `vector-clock-merge` (bidirectional-merge spec)
- ADR-0007 (retirement safety constraints for clock components)
- ADR-0005 (the read-cache column convention this decision reuses)
