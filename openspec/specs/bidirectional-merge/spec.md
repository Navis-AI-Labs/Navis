# bidirectional-merge Specification

## Purpose

> **Capability intent** — When an agent works offline while the project moves forward, the ledger must be able to say how the two streams of work relate instead of silently ordering them. A per-project causal clock records what each participant has observed; a return carries what its author saw; the comparison yields exactly one of four verdicts; and a truly concurrent return is marked for human review rather than resolved by the machine. The clock detects and remembers — it never merges, ranks, or decides.
> **Scope boundary** — This capability defines only: the four-verdict comparison semantics, per-actor monotonic clock maintenance and its replay-rebuild equivalence, the conflict-marking of concurrent returns into the existing human acceptance flow, equip-carried bootstrap snapshots, and the unanimity/atomicity constraints on component retirement within a single project aggregate. Not included: semantic contradiction judgment (a human or semantic-layer concern, not a clock one), any automatic merge or content reconciliation, the participant departure lifecycle that would trigger retirement, checkpoint-context rebuild beyond the state-version anchor, transport or UI surfaces, and cross-project clocks.

## Requirements

### Requirement: clock comparison produces exactly one of four verdicts

Comparing two causal-clock snapshots SHALL yield exactly one verdict: `dominates` when the first snapshot's knowledge includes the second's and records strictly more events from at least one participant, `dominated_by` for the mirror case, `concurrent` when each side records events the other lacks, and `equal` when both record identical knowledge. The verdict SHALL depend only on the two snapshots — comparing A to B and B to A SHALL produce mirrored results, and comparing a snapshot to itself SHALL always produce `equal`.

#### Scenario: parallel branches are detected as concurrent

- **WHEN** two snapshots each record events the other has never observed
- **THEN** the comparison verdict is `concurrent` in both comparison directions

#### Scenario: ordered knowledge is detected consistently

- **WHEN** one snapshot includes every event the other records plus additional events
- **THEN** the comparison verdict is `dominates` in one direction and `dominated_by` in the other, and the same pair never yields `concurrent`

#### Scenario: self-comparison is always equal

- **WHEN** any snapshot is compared against itself
- **THEN** the verdict is `equal`

### Requirement: the authoritative clock advances per actor and never regresses

The project SHALL carry one authoritative causal clock. Every accepted state-changing event SHALL advance the acting participant's component by exactly 1 and SHALL leave every other component unchanged. Any snapshot taken after N accepted events SHALL reflect exactly N advances. Components SHALL be keyed by registered participant identity; an event whose actor has no registered participant identity SHALL be rejected without appending.

#### Scenario: each event advances only its author's component

- **WHEN** a participant submits an accepted command and the authoritative clock is read back
- **THEN** exactly that participant's component advanced by 1 and all other components are unchanged

#### Scenario: unregistered actor is rejected

- **WHEN** a command references an acting identity that is not a registered participant
- **THEN** the kernel rejects the command without appending an event and the clock is unchanged

### Requirement: a concurrent return is marked and routed to human review, never silently ordered

The return submission SHALL accept an optional caller-supplied `causal_context` clock snapshot. When present, the kernel SHALL compare it against the authoritative clock at judgment time and record the verdict (`dominates`, `dominated_by`, `concurrent`, or `equal`) on the return event (`return.absorbed` or `return.rejected`). When the verdict is `concurrent` and the return is otherwise absorbable, the kernel SHALL additionally append a conflict-marking event recording both snapshots and the verdict, and the returned candidates SHALL remain unaccepted candidates subject to the existing human acceptance requirements. The kernel SHALL NOT resolve a concurrent conflict automatically — no clock comparison, merge, or threshold may accept, reject, or discard returned candidates on its own; resolution happens only through the existing human acceptance commands. An ordered verdict (`dominates` or `equal`) SHALL follow the existing return and acceptance rules unchanged.

#### Scenario: concurrent return is marked and left for review

- **WHEN** a return arrives with a causal context whose comparison yields `concurrent` and the return is otherwise absorbable
- **THEN** the return event records the verdict and both snapshots, a conflict-marking event follows it in the same transaction, and the returned candidates stay unaccepted until a human acceptance command resolves them

#### Scenario: ordered return flows through existing rules

- **WHEN** a return arrives with a causal context whose comparison yields `dominates` or `equal`
- **THEN** the return event records the verdict and the existing return and acceptance rules apply without any conflict event

#### Scenario: rejected return still records its verdict

- **WHEN** a return bound to a stale equip arrives with a causal context whose comparison yields any verdict
- **THEN** the wholesale-rejection behavior is unchanged and the recorded rejection event carries the verdict and both snapshots

#### Scenario: no causal context keeps today's behavior

- **WHEN** a return arrives without a causal context
- **THEN** the return behaves exactly as before, no verdict is recorded, and no conflict event is appended

### Requirement: the equip carries the authoritative clock for bootstrap

Equip issuance SHALL stamp the equip with the authoritative clock snapshot as of the equip's state version, so that every participant begins (or resumes) work from the same causal knowledge. A participant that works from a stale snapshot SHALL still be comparable — the snapshot it later presents reflects only the events it actually observed.

#### Scenario: an issued equip carries the current snapshot

- **WHEN** an equip is issued for a work and participant
- **THEN** the equip carries the authoritative clock snapshot matching its state version

### Requirement: clock components are retired only under unanimous atomic conditions

A departed participant's component MAY be removed from the authoritative clock only when every live knowledge holder — including the server-side authoritative clock itself — records the same component value, and the removal SHALL be applied to all holders atomically or not at all. Partial removal SHALL never be externally observable: any snapshot read during retirement either contains the component for all holders or for none. A component that does not satisfy the unanimity condition SHALL be retained.

#### Scenario: unanimous component is retired atomically

- **WHEN** a departed participant's component holds the same value in every live holder and retirement executes
- **THEN** every subsequently read snapshot omits that component, and no snapshot exposes an intermediate state where some holders have it and others do not

#### Scenario: divergent component is retained

- **WHEN** a departed participant's component differs across live holders
- **THEN** the component is retained in every snapshot and no retirement occurs

### Requirement: concurrent verdicts from parallel returns coexist independently

Each return is judged on its own: when multiple participants return from parallel work, the kernel SHALL record a separate verdict and, where applicable, a separate conflict-marking event per return — one return's marking SHALL NOT cancel, resolve, or supersede another's. Parallel work is not limited to two participants: a snapshot may diverge from the authoritative clock across any number of participant components at once, and the comparison result reflects all of them. Human review of each marked return flows independently through the existing acceptance commands.

#### Scenario: two parallel returns are both marked

- **WHEN** two participants return from mutually unaware offline work, and each causal context compares `concurrent` against the authoritative clock at its own judgment time
- **THEN** each return records its own verdict and its own conflict-marking event, both sets of candidates remain unaccepted, and resolving one does not resolve the other

#### Scenario: a later return that observed an earlier one is judged accordingly

- **WHEN** a second return's causal context already includes the events of a first participant's earlier return
- **THEN** the comparison reflects that knowledge — the second return is not marked for the first participant's work it has already observed

### Requirement: the clock detects but never merges content

No command in this capability SHALL alter project state by merging, reconciling, or transforming returned content based on clock comparisons. The clock's only authority is the verdict recorded on events; every state consequence of a verdict flows through the already-adopted human-gated commands (acceptance, rejection, redirection).

#### Scenario: no automatic merge path exists

- **WHEN** a concurrent conflict has been marked and no human acceptance command has run
- **THEN** project state, the returned candidates, and the conflict record are unchanged by the clock alone
