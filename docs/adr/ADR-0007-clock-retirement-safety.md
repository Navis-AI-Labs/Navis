# ADR-0007: Clock component retirement safety constraints

- Status: Proposed
- Date: 2026-09-04

## Context

The causal clock (ADR-0006) grows one component per participant who has
ever acted. Without a removal mechanism, long-lived projects with heavy
participant turnover carry a permanently growing map. Removing
components is therefore desirable — and dangerous: a removed component
compares as zero, so removing it for a participant who is still
observed somewhere turns "never seen them" into a false claim of
knowledge everywhere that removal has propagated.

The property-based benchmark with an independent causal oracle attacked
exactly this surface: naive per-holder pruning of departed participants
produced misjudgments in the correctness matrix (an offline holder
whose peers pruned a component reported parallel work as ordered — 31
wrong verdicts under the canonical adversarial variant), and holder-only
pruning with late joiners misjudged scale scenarios (6 of 3-seed runs)
until joiners started from the authoritative observation instead of
nothing.

## Proposed decision

Component removal (retirement) is subject to three constraints, all of
which must hold — any one alone is insufficient:

1. **Departed only.** A component may be retired only for a participant
   whose departure is a recorded lifecycle fact. Active or paused
   participants are never candidates.
2. **Unanimous across live holders.** Every live knowledge holder —
   every participant whose observation the ledger would still consult,
   including the server's authoritative clock — must agree on the
   component's current value. A single dissenting or uninformed holder
   vetoes: their snapshots still carry the component, and removing it
   anywhere else would make their next comparison claim false
   knowledge.
3. **Atomic.** Retirement is one observable step: no external reader
   may ever observe some holders with the component and others
   without. Partial retirement is prohibited — it is the exact
   intermediate state that produced the benchmark's misjudgments.

Joiner bootstrap is the complementary half: a newly equipped
participant starts from the server's authoritative snapshot (carried on
the equip), never from an empty clock. An empty clock is not neutral —
it claims the joiner has seen nothing, which combined with retirement
elsewhere yields wrong verdicts.

This change ships the safety semantics (default-0 comparison, atomic
snapshot writes, join bootstrap) and the spec constraints; the retirement
**executor** — the command that actually removes components once
participant departure exists — is future work in the participant
lifecycle capability. No removal path exists in this change.

## Consequences

- Steady-state clock size is bounded by active participants, not
  historical participants — but only once the executor exists; until
  then the clock grows monotonically, which the benchmark measured as
  acceptable (linear growth, microsecond compares).
- The constraints are deliberately conservative: a departed
  participant's component survives until unanimity is provable. Correct
  but slower beats fast and wrong — the benchmark's 31-wrong-verdict
  variant is the alternative.
- The retirement executor inherits a pre-verified safety envelope: it
  implements the constraints; it does not need to re-derive them.

## Alternatives

- **Remove on departure immediately (server-side only):** rejected —
  the benchmark's holder-only variants misjudged exactly this way;
  offline holders legitimately still carry the component.
- **Tombstones (keep component, mark inactive):** rejected for the
  clock — it keeps the growth without removing anything; the constraint
  set achieves the same bound with less machinery.
- **No retirement ever:** rejected — unbounded growth with participant
  churn was the measured worst case (the 1000-participant scenario);
  the constraints exist to make eventual removal safe rather than to
  forbid it.

## References

- ADR-0006 (the clock mechanism these constraints protect)
- OpenSpec change `vector-clock-merge` (retirement constraints
  requirement, bidirectional-merge spec)
