# project-state-kernel Spec Delta

## ADDED Requirements

### Requirement: return submission records a causal verdict and marks concurrency

The return submission command SHALL accept an optional `causal_context` clock snapshot. When present, the kernel SHALL compare it against the authoritative clock at judgment time and record the verdict (`dominates`, `dominated_by`, `concurrent`, `equal`) on the return event (`return.absorbed` when the return absorbs, `return.rejected` when it is rejected wholesale). A malformed snapshot SHALL be rejected with the registry error `causal-context-invalid` and no event. When the verdict is `concurrent` and the return absorbs, the kernel SHALL additionally append a `return.conflict_marked` event in the same transaction recording both snapshots and the verdict; the absorbed candidates SHALL remain unaccepted and subject to the existing human acceptance requirements. Absent `causal_context`, the return SHALL behave exactly as before, with no verdict recorded and no conflict event appended.

#### Scenario: concurrent return is marked and left for review

- **WHEN** a return arrives with a causal context whose comparison yields `concurrent` and the return is otherwise absorbable
- **THEN** the `return.absorbed` event records the verdict and both snapshots, a `return.conflict_marked` event follows it in the same transaction, and the absorbed candidates stay unaccepted until a human acceptance command resolves them

#### Scenario: ordered return records the verdict only

- **WHEN** a return arrives with a causal context whose comparison yields `dominates` or `equal`
- **THEN** the return event records the verdict and no conflict event is appended

#### Scenario: wholesale-rejected return still records its verdict

- **WHEN** a return bound to a stale equip arrives with a causal context
- **THEN** the wholesale-rejection behavior is unchanged and the `return.rejected` event carries the verdict and both snapshots

#### Scenario: malformed causal context is rejected

- **WHEN** a return arrives with a causal context that is not a valid clock snapshot
- **THEN** the kernel rejects with `causal-context-invalid` and appends nothing

#### Scenario: no causal context keeps today's behavior

- **WHEN** a return arrives without a causal context
- **THEN** the return behaves exactly as before, no verdict is recorded, and no conflict event is appended

### Requirement: the equip carries the authoritative clock for bootstrap

Equip issuance SHALL stamp the equip with the authoritative clock snapshot as of the equip's state version, so that every participant begins or resumes work from the same causal knowledge. A participant that works from a stale snapshot SHALL still be comparable — the snapshot it later presents reflects only the events it actually observed.

#### Scenario: an issued equip carries the current snapshot

- **WHEN** an equip is issued for a work and participant
- **THEN** the equip carries the authoritative clock snapshot matching its state version

### Requirement: the authoritative clock advances per actor and never regresses

The project SHALL carry one authoritative causal clock, reconstructible in full by replay from event authorship. Every accepted state-changing event SHALL advance the acting participant's component by exactly 1 and SHALL leave every other component unchanged. Components SHALL be keyed by registered participant identity; an event whose actor is not a registered participant SHALL be rejected with the registry error `causal-actor-unregistered` and appended to no event. Clock components MAY be removed only for departed participants whose component is unanimous across all live knowledge holders, and the removal SHALL be atomic — no externally observable state may show some holders with the component and others without.

#### Scenario: each event advances only its author's component

- **WHEN** a participant submits an accepted command and the authoritative clock is read back
- **THEN** exactly that participant's component advanced by 1 and all other components are unchanged

#### Scenario: the clock is rebuilt by replay

- **WHEN** the projection is rebuilt from the event history
- **THEN** the reconstructed clock equals the clock built incrementally, for every participant component

#### Scenario: unregistered actor is rejected

- **WHEN** a command references an acting identity that is not a registered participant
- **THEN** the kernel rejects with `causal-actor-unregistered` and the clock is unchanged
