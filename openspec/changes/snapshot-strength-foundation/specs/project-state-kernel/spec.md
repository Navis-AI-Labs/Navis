# project-state-kernel Spec Delta

## MODIFIED Requirements

### Requirement: current state is a versioned projection rebuilt by replay

Current state must be verifiable against the ledger at any time — full replay is the tamper check that makes silent corruption detectable. The kernel SHALL maintain a current-state projection derived exclusively by replaying the event history. Version semantics are four distinct concepts: the per-project event sequence (`seq`, monotonic, 1-based — concurrency carrier), per-sub-aggregate revisions (carried by the event envelope's `aggregate_revision`), the Project State version (`project_state_version`, incremented ONLY by State-material events: boundary updates, project status changes, acceptance-criteria structure changes), and the replay cursor (rebuildable, not a semantic field). The projection version (`project_state_version`) SHALL be monotonically increasing. Rebuilding the projection from the full event log SHALL produce a projection structurally identical (canonical JSON equality) to the live projection. Replay MAY restore the projection from a caller-supplied snapshot whose cursors match the log instead of folding the entire history; the restored-plus-incremented projection SHALL remain canonically identical to the full replay of the same log, and an unusable supplied snapshot SHALL fail replay explicitly rather than silently diverge or be silently discarded. Snapshot capture policy, the policy event's governance, and restore semantics are owned by the `snapshot-strategy` capability; this requirement pins only the identity law they must satisfy.

#### Scenario: replay rebuilds identically

- **WHEN** a kernel accumulates 200 events across assets, holds, equips, and boundary updates, and a fresh kernel rebuilds its projection from the same event log
- **THEN** the canonical JSON of the rebuilt projection equals the live projection

#### Scenario: version increases only via State-material events

- **WHEN** a State-material event occurs (boundary update, project status change)
- **THEN** project_state_version increases by exactly 1
- **AND WHEN** a non-State-material state change occurs (hold registration, asset acceptance, work redirection, capture-policy update)
- **THEN** an event is appended (seq advances) but project_state_version is unchanged

#### Scenario: optimistic concurrency detects stale or divergent writers

- **WHEN** a write attempt supplies an expected project state version different from the current project state version
- **THEN** the kernel rejects the write with a version-conflict error and the event log is unchanged; matching the project state version does not establish that no other event has been appended

#### Scenario: snapshot-assisted replay stays identical to full replay

- **WHEN** a caller-supplied snapshot matches the event log and replay restores from it, folding only the events after it
- **THEN** the canonical JSON of the resulting projection equals the projection produced by folding the entire log from the beginning

#### Scenario: a policy update advances the sequence without touching version or direction fields

- **WHEN** a capture-policy update event is appended
- **THEN** the event sequence advances while project_state_version is unchanged and the boundary summary and acceptance criteria are unchanged in the projection

## ADDED Requirements

### Requirement: asset lifecycle transitions are human-only and reason-gated

Retirement of knowledge is a governed business process, and confirming a strength suggestion requires an explicit human act. The kernel's `transition_asset` command SHALL be human-only: an agent actor SHALL be rejected with a structured `forbidden` error naming the actor kind, before any event is appended. The command SHALL require a written reason: a missing or blank reason SHALL be refused with `rationale-required` before lifecycle eligibility is considered. The reason SHALL be recorded with the lifecycle event. Existing lifecycle eligibility, grace periods, and purge conditions continue to apply.

#### Scenario: an agent cannot execute a lifecycle transition

- **WHEN** an agent participant attempts any asset lifecycle transition
- **THEN** the command is rejected with `forbidden { actor_kind: 'agent' }` and no event is appended

#### Scenario: a blank or missing reason is refused before lifecycle checks

- **WHEN** a human executes a lifecycle transition with a missing or whitespace-only reason
- **THEN** the kernel returns `rationale-required` and nothing changes

#### Scenario: a human transition with a reason appends the audited event

- **WHEN** a human executes a legal transition with a written reason
- **THEN** the lifecycle event is appended carrying the actor and the reason

### Requirement: public views cannot mutate authority or bypass acceptance

Objects returned by reads and commands SHALL be immutable, isolated views of the kernel's authority. Mutating a returned event collection, projection, or row SHALL not change history or live state. Candidate promotion and rejection SHALL require an Acceptance record; the general lifecycle command SHALL not provide an alternative route. Delivery SHALL require a recorded accepted verdict for its asset in addition to the existing gates. A purge SHALL reject an age that is not a finite number satisfying the retention threshold.

#### Scenario: a consumer attempts to change a returned value

- **WHEN** a consumer attempts to remove an event or change a returned boundary, asset, or command result
- **THEN** authority remains unchanged and replay integrity holds

#### Scenario: lifecycle activation cannot substitute for acceptance

- **WHEN** a participant attempts to activate or reject a candidate using the general lifecycle command
- **THEN** the command refuses and no acceptance or lifecycle event is fabricated

#### Scenario: missing acceptance blocks delivery

- **WHEN** delivery is attempted without a recorded accepted verdict for the asset
- **THEN** delivery is refused even if the supplied state describes the asset as active

### Requirement: participation contracts preserve identity and recovery data

An issued Equip SHALL return its recorded causal snapshot and participant identity to its caller. A Return SHALL belong to the participant to whom its Equip was issued. A pause checkpoint SHALL use a valid domain identifier and retain supplied recovery references. Intervention session identities SHALL be unique within a run, including closed sessions; one close command SHALL close only its named session. Deterministic submission criteria SHALL agree with the kernel's unconditional human-only gates.

#### Scenario: the caller can bootstrap from the returned Equip

- **WHEN** an Equip is issued
- **THEN** its returned causal snapshot equals the issuance record's snapshot and cannot mutate that record

#### Scenario: another participant presents an Equip

- **WHEN** a Return names an Equip issued to another participant
- **THEN** it is refused without absorbing candidates or effects

#### Scenario: a run resumes after the project boundary changes

- **WHEN** a run resumes after its input business version is superseded
- **THEN** it must present a current Equip for the acting participant and, when work-scoped, the same Work; the old Equip cannot authorize resumption

#### Scenario: caller time moves backward after takeover release

- **WHEN** a new Equip is issued after a takeover release in recorded event order but carries an earlier caller timestamp
- **THEN** it satisfies the post-release freshness requirement; an Equip recorded before the release remains stale

#### Scenario: pause and replay preserve external recovery references

- **WHEN** a run pauses with recovery references
- **THEN** the checkpoint has a valid domain identifier and the references survive full and snapshot-assisted replay

#### Scenario: a duplicate session identity is refused

- **WHEN** an intervention opens with an identity already used on that run
- **THEN** it is refused without changing sessions, revision, history, or the causal clock

### Requirement: commands preserve the shared object-field constraints

Commands SHALL reject field values that violate the shared domain object contract before recording any event. Rejection SHALL identify the affected field and leave history, projection, and causal state unchanged. A successful command SHALL leave a projection that can be captured and restored under the same field contract.

Persisted event data SHALL satisfy the same shared field contract. Replay and integrity verification SHALL report invalid event data explicitly; matching reconstructed state alone SHALL NOT establish field validity.

#### Scenario: invalid fields cannot poison later capture

- **WHEN** a command supplies an invalid title, enumeration, reference format, collection size, or recovery reference
- **THEN** it is refused with field-level detail and the existing state remains capturable

#### Scenario: a rejected verdict input cannot partially record acceptance

- **WHEN** an acceptance command supplies invalid verdict fields or evidence references
- **THEN** no acceptance or lifecycle event is recorded and the candidate remains unchanged

#### Scenario: valid boundary values survive capture and replay

- **WHEN** valid values at the shared field limits are supplied to commands
- **THEN** the resulting state can be captured and both full replay and snapshot-assisted replay preserve it

#### Scenario: invalid historical fields cannot pass an integrity audit

- **WHEN** a recorded event contains a Work title or other field that violates the shared object contract
- **THEN** replay or integrity verification reports the invalid event and field, even when replay could reconstruct the same invalid state
