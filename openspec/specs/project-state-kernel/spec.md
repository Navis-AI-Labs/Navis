# project-state-kernel Specification

## Purpose

> **Capability intent** — The kernel is Navis's trust engine. It makes two iron rules mechanically impossible to bypass: **history cannot be rewritten** (the ledger is append-only and the present state is verified by replay) and **AI proposes, humans enact** (only humans can change boundaries, only humans can render judgments, and an agent's concern becomes a fact only through human confirmation). The verified kernel behaviors — append-only ledger, versioned projection, Equip/Return, the delivery gate, the Hold confirmation chain — become system behavior here.
> **Scope boundary** — This capability defines only: events, projection, concurrency, boundaries, Equip/Return, delivery gate, Hold semantics, and the error-code/constant registries within a single project aggregate. Not included: HTTP or any transport surface (contracts capability), agent runtimes and tool execution (agent-access capability), the WorkRun transition machine and intervention concurrency rules (not defined by this capability), cross-project aggregates (project merge/absorption migrations are outside a single-project kernel), and the authentication/authorization system (this capability only enforces the human-role checks; the full authorization system is not defined by this capability).

## Requirements

### Requirement: error codes are a closed, namespaced, add-only registry

Error tokens and tuning thresholds are cross-module contracts in a multi-module system; ad-hoc literals and magic numbers make them unfindable and untestable. The kernel SHALL expose its entire error surface as a closed registry of stable kebab-case string tokens. Each token SHALL resolve to an external URN of the form `kernel/<token>` (module-namespaced). The registry MUST be typed such that adding a token is a one-line change, while renaming or removing a token fails compilation of dependent code. Domain error objects SHALL carry `{ module, code, urn, details? }` and MUST NOT carry localized messages; message rendering and transport mapping belong to edge layers. The registry is add-only: reusing an existing token for a different meaning is forbidden. Kernel tuning constants (equip size budget, purge age threshold, competitive grace period) SHALL live in a named-constants registry with provenance comments; kernel logic MUST NOT use magic numbers for these values.

#### Scenario: all kernel rejections use registry tokens

- **WHEN** any kernel rejection listed in this spec occurs (forbidden, rationale-required, version-conflict, equip-budget-exceeded, unaccepted-artifact, blocking-hold, unknown-effect-unclosed, project-not-active, open-attempt-exists)
- **THEN** the returned error object's code is the corresponding registry token and its urn is `kernel/<token>`

#### Scenario: registry is exhaustive for the kernel surface

- **WHEN** the registry's token set is compared against every rejection path in the kernel
- **THEN** every rejection path emits a token present in the registry
- **AND** no rejection path constructs an error from a bare string literal

#### Scenario: renaming a token breaks compilation

- **WHEN** a token name is changed in the registry
- **THEN** dependent typed references fail to compile (the token set forms a literal-keyed const object)

#### Scenario: constants are named, not magic

- **WHEN** kernel logic gates equip issuance by size or purge by age
- **THEN** the compared values are named constants from the constants registry with provenance comments
- **AND** no numeric literal for these thresholds appears in kernel logic

### Requirement: event history is append-only and structurally immutable

The append-only ledger is the system's memory of record: the judgment history is the product, so retroactive edits would corrupt the very thing being built. The project state kernel SHALL store all state changes as events in an append-only history. Appended events MUST be frozen (structural immutability: attempts to mutate an appended event SHALL fail or be detected). No API of the kernel SHALL offer update or delete on appended events. Each event carries: `seq` (monotonic, 1-based), `type` (event type string), `data` (payload object), `actor` (acting Participant id), `at` (logical time provided by the caller), `state_version` (version after this event), and `schema_version` (the envelope schema version, stamped by the kernel on every appended event).

#### Scenario: append succeeds and seq is monotonic

- **WHEN** three events are appended in order
- **THEN** their seq values are exactly 1, 2, 3

#### Scenario: appended event resists mutation

- **WHEN** a consumer attempts to mutate a field of an appended event (direct property write or array element replacement)
- **THEN** the mutation fails (frozen object) or is detected as tampering by the kernel's integrity check

#### Scenario: delete and update are not offered

- **WHEN** inspecting the kernel's public surface
- **THEN** no method exists that removes or rewrites an appended event

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

### Requirement: boundary versioning is human-only and reason-gated

Setting direction is human accountability: the people paying alignment costs must be the people who sign them, and every pivot must leave a reason the ledger can replay later. Boundary updates (goal, acceptance criteria, constraints) MUST be performed by a human Participant and MUST carry a non-empty reason. An agent-attempted boundary update MUST be rejected with a forbidden error and MUST leave zero state pollution (no event appended). Boundary updates SHALL update Project.boundary (the current effective summary) and increment Project.current_state_version (a State-material event), and invalidate every Equip bound to an older state_version (the full-invalidation response: stale equips are marked stale and in-flight returns against them are rejected wholesale).

#### Scenario: human boundary update advances the version and invalidates stale equips

- **WHEN** a human actor submits a boundary update with a reason while two equips exist at the previous version
- **THEN** the update is recorded as an event, current_state_version increases, the boundary summary and criteria are updated in the projection
- **AND** both equips are marked stale

#### Scenario: agent boundary update is rejected without pollution

- **WHEN** an agent actor submits a boundary update
- **THEN** the kernel returns a forbidden error
- **AND** the event log length and state_version are unchanged

#### Scenario: missing reason is rejected

- **WHEN** a human actor submits a boundary update with an empty reason
- **THEN** the kernel returns a rationale-required error and appends nothing

### Requirement: project lifecycle is human-gated, reason-carrying, and non-destructive

Real projects do not binary live/die: they pause (stakeholders diverting attention), complete (goal met), and close (business line ends — including the case where the work continues as a sub-business of another product; the record stays archived, not deleted). None of these deletes history. Project status SHALL be exactly the accepted baseline's four values: active, paused, completed, archived. Every transition SHALL be human-only with a required reason and SHALL append an event carrying actor and reason. In every non-active status the project MUST reject boundary updates, equip issuance, returns, and deliveries with project-not-active. Paused is reversible (resume with reason); completed and archived are terminal. Completion SHALL be refused while any blocking hold is active (finishing must not silently erase open obligations — resolve the hold first). On archive, incomplete works become cancelled and non-resolved holds (registered/active) become invalidated, each closure event carrying the cause — a hold is never pretended resolved. Work creation, cancellation, and redirection SHALL likewise be human-gated and reason-carrying. Work redirection (redirect_work) updates only Work.direction and creates a Checkpoint (default on) — it does NOT bump current_state_version (a method correction is not a boundary change; it advances the event seq and the Work aggregate revision while project_state_version stays unchanged). Cross-project absorption/merge is out of scope for the single-project kernel.

#### Scenario: pause locks, resume unlocks

- **WHEN** a human pauses an active project with a reason
- **THEN** equips, returns, boundary updates, and deliveries are rejected with project-not-active
- **AND WHEN** a human later resumes the project with a reason
- **THEN** those operations succeed again

#### Scenario: completion is refused while a blocking hold is active

- **WHEN** a human attempts to complete a project that still has an active blocking hold
- **THEN** the kernel rejects with blocking-hold and nothing changes
- **AND WHEN** the hold is resolved and completion is retried
- **THEN** completion succeeds

#### Scenario: project archive closes everything human-verifiably

- **WHEN** a human archives a project with a reason while it has one active blocking hold, one registered agent hold, and two incomplete works
- **THEN** both incomplete works become cancelled; both holds become invalidated and each closure event carries the archive cause; no hold is pretended resolved
- **AND** subsequent boundary updates, equip requests, and deliveries are rejected with project-not-active
- **AND** previously accepted assets remain queryable as history

#### Scenario: agent cannot transition project status

- **WHEN** an agent attempts to pause, complete, or archive a project
- **THEN** the kernel returns forbidden and no state changes

#### Scenario: work redirection updates direction without version bump

- **WHEN** a human redirects a work with a reason
- **THEN** the work's direction reflects the new direction immediately
- **AND** a Checkpoint is created carrying the redirect reason
- **AND** current_state_version is unchanged (method correction is not a boundary change; the event seq advances while project_state_version stays unchanged)

#### Scenario: status transition requires a reason

- **WHEN** a human pauses, completes, or archives a project without a reason
- **THEN** the kernel returns rationale-required and nothing changes

### Requirement: equip is a derived contract carrying facts, holds, goal, criteria, and allowed effects

The Equip is the work contract between human intent and agent execution: it fixes what the agent may treat as fact, what is still withheld, and what effects are allowed. Stale contracts must not silently mix with new state. On request, the kernel SHALL derive an Equip for a work and participant: verified_facts (the ids of lifecycle=active assets visible under the single scope-visibility predicate), active_assets (lifecycle in active/candidate, same predicate), active_holds (status=active hold ids narrowed to the equip's work: a hold qualifies when its `registered_during_work` equals the equip's `work_id`, OR when `registered_during_work` is unset/null — a hold not attributed to any work is project-wide and SHALL appear in every equip), the current boundary summary and acceptance criteria, the state_version the equip is bound to, and allowed_actions. **Projection read paths for assets SHALL route through the same scope predicate**: the minimal surface offers `listAssets` (all alive project-visible assets, optional filters) and `getAssetById` — the latter returns not-found (never a leaked row) when the row fails the predicate, so callers cannot distinguish out-of-scope rows from genuinely absent ones.

Scope visibility for Equip derivation AND read paths SHALL be owned by one domain predicate; no derivation or read site may test scope inline. In the current model, visible means project scope: participant-, session-, and task-scope assets carry no ownership attribution today and SHALL NOT appear in the Equip-derived set or the read surface; organization-scope assets belong outside the project and SHALL NOT appear either. Any future change making narrower scopes visible SHALL extend the single predicate with newly admitted attribution fields, never by re-litigating the rule at a call site. Equip is a derived projection: it is never stored as independent business data. Equip issuance MUST fail explicitly when the serialized fact set exceeds the configured size budget (event recorded, diagnostic payload with fact count/serialized length/budget returned). A Return bound to a stale equip version MUST be rejected wholesale (no partial absorption: candidates and effects of a rejected return MUST NOT enter the projection; a rejection event is recorded).

#### Scenario: equip carries current facts and holds

- **WHEN** an equip is requested after two assets are active at project scope and one hold is active and registered during the equip's work
- **THEN** the equip's verified_facts contain exactly those two asset ids and its active_holds contain exactly that hold id
- **AND** the equip's state_version equals the current state_version

#### Scenario: a hold of another work never enters the equip

- **WHEN** an equip is requested for work W1 while an active hold is registered during a different work W2
- **THEN** the equip's active_holds SHALL NOT contain that hold id

#### Scenario: a project-wide hold enters every equip

- **WHEN** an equip is requested for work W1 while an active hold has no `registered_during_work` (project-wide)
- **THEN** the equip's active_holds contain that hold id
- **AND WHEN** an equip is requested for any other work in the same project
- **THEN** that equip's active_holds also contain that hold id

#### Scenario: verified_facts stay project-wide regardless of work narrowing

- **WHEN** two equips are issued for two different works in the same project
- **THEN** both verified_facts sets are identical (project-wide), while their active_holds may differ
- **AND** this divergence is the contract's canonical expression of "facts are the project's, holds are the work's"

#### Scenario: the list path respects the scope predicate

- **WHEN** the kernel contains two alive assets — one project-scope, one participant-scope — and a caller lists assets
- **THEN** the result set contains only the project-scope asset id
- **AND** the participant-scope asset is absent, even though the raw projection contains it

#### Scenario: the get-by-id path returns not-found for out-of-scope rows

- **WHEN** a caller requests `getAssetById` for an id whose alive row exists at scope participant
- **THEN** the method returns not-found (no leaked payload)
- **AND** the same id of a genuinely dead row ALSO returns not-found, so the caller cannot distinguish "out of scope" from "absent"

#### Scenario: budget overflow fails explicitly

- **WHEN** the serialized fact list length exceeds the configured budget
- **THEN** equip issuance fails with equip-budget-exceeded
- **AND** a budget-exceeded event is appended and the error carries fact count, serialized length, and budget

#### Scenario: non-project-scope assets never enter facts

- **WHEN** an equip is requested with an active task-scope asset present
- **THEN** that asset does not appear in the equip's verified_facts or active_assets
- **AND WHEN** an equip is requested with an active participant-scope asset present
- **THEN** that asset does not appear in verified_facts or active_assets either (scope isolation)

#### Scenario: session-scope assets never enter facts

- **WHEN** an equip is requested with an active session-scope asset present
- **THEN** that asset does not appear in the equip's verified_facts or active_assets

#### Scenario: organization-scope assets stay outside the project derivation

- **WHEN** an equip is requested with an active organization-scope asset present
- **THEN** that asset does not appear in the equip's verified_facts or active_assets

#### Scenario: the rule lives in one place

- **WHEN** the Equip derivation or the read surface is inspected
- **THEN** every scope decision routes through the single scope-visibility predicate and no site compares scope literals inline

#### Scenario: stale return is rejected wholesale

- **WHEN** a return arrives bound to a version older than the current state_version
- **THEN** the kernel rejects with version-conflict
- **AND** the return's candidates and effects do not appear in the projection
- **AND** a return-rejected event is appended

### Requirement: delivery gate checks unaccepted artifacts, blocking holds, and unclosed effects in order

Delivery is a promise to the physical world; it must be gated by acceptance truth first, then human-retained concerns, then closed side effects, then delivery-attempt exclusivity — in that fixed order, because each earlier gate makes the later one moot. Delivery is per-asset (the accepted deliver_result action targets one Asset and creates one Delivery record with its target). The kernel SHALL refuse delivery of an asset when (checked in order): the project is not active; the asset is not lifecycle=active (unaccepted-artifact) or carries no content sha256 anchor (the Delivery record's version is the asset's content sha256 — an accepted artifact without one is not deliverable, rejected as forbidden); a blocking hold is active whose asset_refs chain contains the asset (blocking-hold); any side effect of the delivery is in unknown state (unknown-effect-unclosed; an unclosed unknown effect blocks delivery); an open delivery attempt already exists for the same (asset, target) pair (open-attempt-exists — a retry after the business side rejects is a NEW attempt whose attempt_no advances, and is admitted only after the prior attempt is terminal). A fully gated delivery SHALL append a delivered event carrying the delivering Participant id, the asset, the target, and the asset's content sha256 anchor, so the audit chain names who promised what to the physical world.

#### Scenario: unaccepted artifact blocks with named ids

- **WHEN** delivery is attempted for an asset still in candidate lifecycle
- **THEN** delivery fails with unaccepted-artifact naming that asset id

#### Scenario: blocking hold blocks after acceptance passes

- **WHEN** the asset is active and a blocking hold referencing it is active
- **THEN** delivery fails with blocking-hold

#### Scenario: unclosed unknown effect blocks

- **WHEN** an effect is in unknown state and no other gate fails
- **THEN** delivery fails with unknown-effect-unclosed
- **AND WHEN** the effect is confirmed as failed (did not happen)
- **THEN** delivery succeeds (closed ledger equals reality; closure is not success)

#### Scenario: clean delivery succeeds

- **WHEN** the asset is active, no blocking hold references it, all its delivery effects are closed, and no open attempt exists for the asset+target pair
- **THEN** delivery succeeds: one Delivery record is created for the asset+target carrying the asset's content sha256 as its version, and a delivered event is appended carrying the delivering Participant id

#### Scenario: a second open attempt for the same asset and target is rejected

- **WHEN** a delivery attempt exists for the asset+target whose confirmation_status is delivered or pending, and another delivery to the same target is attempted
- **THEN** delivery fails with open-attempt-exists naming the asset id, target ref, and open attempt number
- **AND WHEN** the business side rejects the open attempt (a terminal confirmation) and delivery is retried
- **THEN** the retry succeeds as a NEW attempt whose attempt_no advances (the rejected attempt is never rewritten in place)

### Requirement: hold confirmation follows ai-proposes-human-enacts

An agent's concern is a proposal, not a fact; it becomes a fact — with delivery-blocking force — only through a named human's confirmation. A hold registered by an agent SHALL be created in registered status and MUST NOT block delivery until a human Participant transitions it to active. A hold registered by a human SHALL be active immediately. Hold lifecycle transitions SHALL follow the accepted baseline (registered→active; active→resolved/accepted/dormant/invalidated; dormant→active on direction rollback; dormant→invalidated), each transition event recording the acting Participant id (audit chain). Hold reactivation (dormant/invalidated/accepted/resolved → active, per the accepted reactivate_hold action) MUST be human-only with a required reason; the accepted actions carry check_actor_permission and a required reason.

#### Scenario: agent hold does not block until confirmed

- **WHEN** an agent registers a blocking hold
- **THEN** the hold is registered (not active) and delivery is not blocked by it
- **AND WHEN** a human confirms the hold (registered→active)
- **THEN** the hold is active and delivery is blocked

#### Scenario: hold events carry actors

- **WHEN** holds are registered, confirmed, resolved, accepted, or invalidated
- **THEN** each corresponding event's data includes the acting Participant id

#### Scenario: agent reactivation is forbidden

- **WHEN** an agent attempts to reactivate a dormant, invalidated, accepted, or resolved hold
- **THEN** the kernel returns forbidden and state is unchanged

#### Scenario: reactivation without reason is rejected

- **WHEN** a human reactivates a dormant hold without a reason
- **THEN** the kernel returns rationale-required

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

### Requirement: the blocks_delivery declaration and the blocking-hold delivery gate are pinned together

The vocabulary's `blocks_delivery` link type declaration and the kernel's blocking-hold delivery gate SHALL be verified against each other: the declaration names `Hold` as from-type and `Delivery` as to-type, and the gate refuses delivery of an asset while a blocking hold is active. A change to one side without the other SHALL fail validation naming the mismatch, so the declared relation and the enforced behavior cannot drift apart silently.

#### Scenario: declaration and gate agree

- **WHEN** the `blocks_delivery` declaration is checked against the delivery gate
- **THEN** the declared endpoints are `Hold` and `Delivery`, and the gate refuses delivery while a blocking hold on the asset is active

#### Scenario: drift fails loudly

- **WHEN** the declaration is altered — renamed, re-endpointed, or removed — while the gate still enforces blocking holds, or the gate stops enforcing while the declaration stands
- **THEN** validation fails naming the mismatch between declaration and behavior

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

### Requirement: the effect ledger is authoritative for side-effect facts

The kernel SHALL maintain the Effect Ledger as the single source of truth for side-effect facts: an effect SHALL first be recorded as intent (`recordEffectIntent` / `effect.intent_recorded`) BEFORE its executor runs against the outside world; replaying the same intent key SHALL return the already-recorded row with zero new events and zero new rows; and a late cancellation SHALL be materialized via `cancelEffectLate` / `effect.cancel_recorded` without rolling anything back.

Beyond the E1 surface: the ledger SHALL distinguish "intent that has never been attempted" from "intent mid-execution" by elevating execution start to a real state, `executing`. Row closure SHALL be allowed only from `executing` (closing straight from `unknown` is rejected as `forbidden: effect-not-executing` — read: the ledger cannot bear a claim that an effect ran when no `effect.execution_begun` event exists). Stuck executors SHALL be drainable only through an explicit `resetEffectExecution` call, which returns the row to `unknown` and increments its `execution_attempts` counter (visible in the event payload as `attempts_next`).

#### Scenario: intent is recorded before the effect runs

- **WHEN** a caller records an intent for an effect that has not yet run (no `effect.intent_recorded` event exists yet)
- **THEN** the ledger contains one row in `unknown` status, the event log gains exactly one `effect.intent_recorded` event, and a subsequent begin transitions it cleanly

#### Scenario: duplicate intent replay returns the same row without writing again

- **WHEN** a caller records an effect intent with intent key K twice
- **THEN** the second call returns the same row id
- **AND** the log contains exactly one `effect.intent_recorded` and one row

#### Scenario: late cancel is marked unknown, never rolled back

- **WHEN** an effect is in `unknown` and `cancelEffectLate` fires
- **THEN** the row still shows `unknown` with `late_cancel_received: true` and exactly one `effect.cancel_recorded` event

#### Scenario: confirmed/failed after late cancel is refused

- **WHEN** an effect row carries `late_cancel_received=true`
- **AND** a caller attempts to close the effect with outcome `confirmed`
- **THEN** the kernel rejects with `forbidden:effect-cancelled` and appends nothing

#### Scenario: late cancel on already-closed effects is refused

- **WHEN** an effect is already in `confirmed` or `failed` and `cancelEffectLate` is called
- **THEN** the kernel rejects with `forbidden:effect-already-closed` and no `late_cancel_received` stamps

#### Scenario: intent can only begin once

- **WHEN** an effect row is in `unknown` status
- **AND** the actor calls `beginEffectExecution(effect_id)`
- **THEN** the row's status becomes `executing` and exactly one `effect.execution_begun` event is recorded
- **AND WHEN** the actor calls `beginEffectExecution` again
- **THEN** the kernel rejects with `forbidden`

#### Scenario: crash mid-execution is observable after replay

- **WHEN** an effect is `executing` and the executor process dies
- **AND** a rebuilt kernel replays the event log
- **THEN** the row appears in `listExecutingEffects()` (new read) with status `executing` and its original attempt metadata

#### Scenario: executors must reset before retry

- **WHEN** an executing effect's caller decides to retry
- **AND** the caller performs `resetEffectExecution(effect_id, reason)`
- **THEN** the row goes back to `unknown`, the `effect.execution_reset` event records `{ effect_id, reason, attempts_next }`, and `execution_attempts` increments by 1
- **AND** a later `beginEffectExecution` is now legal

#### Scenario: close from `unknown` is now rejected

- **WHEN** a caller calls `closeEffect` on a row that is still `unknown` (never begun)
- **THEN** the kernel returns `forbidden:effect-not-executing` and no `effect.closed` event is written
- **AND WHEN** the caller properly begins the effect first
- **THEN** the same close call succeeds

#### Scenario: executing + late cancel cannot quietly confirm

- **WHEN** an `executing` effect has `late_cancel_received: true`
- **AND** the executor tries to close with outcome `confirmed`
- **THEN** the result is `forbidden:effect-cancelled`
- **AND WHEN** the executor closes with `failed` instead
- **THEN** the row settles terminal in `failed`

### Requirement: pending effect recovery predicate

The kernel SHALL expose a read predicate `listPendingEffects(): EffectRow[]` that returns every alive Effect row with status `unknown`. A row marked `late_cancel_received` but still in `unknown` status SHALL remain listed (the late cancel does not settle the fact; only confirmation or failure does). A row whose status has moved to `confirmed` or `failed` SHALL NOT be returned. A soft-deleted, tombstoned, or projected-away row SHALL NOT be returned. This predicate is the single source of truth for the crash-recovery question "which effects still need executor confirmation?" — no caller may re-derive it from `projection.effects` directly.

#### Scenario: unknown effects are pending recovery

- **WHEN** the ledger holds two `unknown` effects — one fresh from `recordEffectIntent`, one stamped `late_cancel_received`
- **THEN** `listPendingEffects` returns both
- **AND** an effect-row count comparison with `projection.effects` also lists both

#### Scenario: confirmed/failed rows leave the list

- **WHEN** one pending-effect row is closed as confirmed
- **AND** another is closed as failed
- **THEN** after closure, `listPendingEffects` omits both

#### Scenario: replay round-trip preserves the same answer

- **WHEN** a kernel contains N pending effects
- **AND** its events are replayed through `ProjectStateKernel.fromEvents` (equivalent to a crash-recovery boot path)
- **THEN** the rebuilt kernel returns an identical pending list under `listPendingEffects`

#### Scenario: cancel-before-settle stays pending

- **WHEN** an effect was late-cancelled (row carries `late_cancel_received: true`)
- **AND** it is still in `unknown` status
- **THEN** `listPendingEffects` still returns the row
- **AND WHEN** the row is closed (any outcome)
- **THEN** the row leaves the pending list immediately
