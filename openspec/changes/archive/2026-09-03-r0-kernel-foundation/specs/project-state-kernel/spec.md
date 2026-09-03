# project-state-kernel Spec Delta

> **Capability intent** — The kernel is Navis's trust engine. It makes two iron rules mechanically impossible to bypass: **history cannot be rewritten** (the ledger is append-only and the present state is verified by replay) and **AI proposes, humans enact** (only humans can change boundaries, only humans can render judgments, and an agent's concern becomes a fact only through human confirmation). The verified kernel behaviors — append-only ledger, versioned projection, Equip/Return, the delivery gate, the Hold confirmation chain — become system behavior here.
> **Scope boundary** — This capability defines only: events, projection, concurrency, boundaries, Equip/Return, delivery gate, Hold semantics, and the error-code/constant registries within a single project aggregate. Not included: HTTP or any transport surface (contracts capability), agent runtimes and tool execution (agent-access capability), the WorkRun transition machine and intervention concurrency rules (not defined by this capability), cross-project aggregates (project merge/absorption migrations are outside a single-project kernel), and the authentication/authorization system (this capability only enforces the human-role checks; the full authorization system is not defined by this capability).

## ADDED Requirements

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

Current state must be verifiable against the ledger at any time — full replay is the tamper check that makes silent corruption detectable. The kernel SHALL maintain a current-state projection derived exclusively by replaying the event history. Version semantics are four distinct concepts: the per-project event sequence (`seq`, monotonic, 1-based — concurrency carrier), per-sub-aggregate revisions (carried by the event envelope's `aggregate_revision`), the Project State version (`project_state_version`, incremented ONLY by State-material events: boundary updates, project status changes, acceptance-criteria structure changes), and the replay cursor (rebuildable, not a semantic field). The projection version (`project_state_version`) SHALL be monotonically increasing. Rebuilding the projection from the full event log SHALL produce a projection structurally identical (canonical JSON equality) to the live projection.

#### Scenario: replay rebuilds identically

- **WHEN** a kernel accumulates 200 events across assets, holds, equips, and boundary updates, and a fresh kernel rebuilds its projection from the same event log
- **THEN** the canonical JSON of the rebuilt projection equals the live projection

#### Scenario: version increases only via State-material events

- **WHEN** a State-material event occurs (boundary update, project status change)
- **THEN** project_state_version increases by exactly 1
- **AND WHEN** a non-State-material state change occurs (hold registration, asset acceptance, work redirection)
- **THEN** an event is appended (seq advances) but project_state_version is unchanged

#### Scenario: optimistic concurrency detects stale or divergent writers

- **WHEN** a write attempt arrives with an expected version that is older than OR not equal to the current state_version
- **THEN** the kernel rejects the write with a version-conflict error and the event log is unchanged (equality — not merely freshness — is the pass condition, so two writers racing at the same version cannot both succeed)

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

The Equip is the work contract between human intent and agent execution: it fixes what the agent may treat as fact, what is still withheld, and what effects are allowed. Stale contracts must not silently mix with new state. On request, the kernel SHALL derive an Equip for a work and participant: verified_facts (the ids of lifecycle=active AND scope=project assets — the accepted baseline's derivation rule), active_assets (scope-filtered, lifecycle in active/candidate), active_holds (status=active hold ids), the current boundary summary and acceptance criteria, the state_version the equip is bound to, and allowed_actions. Equip is a derived projection: it is never stored as independent business data. Equip issuance MUST fail explicitly when the serialized fact set exceeds the configured size budget (event recorded, diagnostic payload with fact count/serialized length/budget returned). A Return bound to a stale equip version MUST be rejected wholesale (no partial absorption: candidates and effects of a rejected return MUST NOT enter the projection; a rejection event is recorded).

#### Scenario: equip carries current facts and holds

- **WHEN** an equip is requested after two assets are active at project scope and one hold is active
- **THEN** the equip's verified_facts contain exactly those two asset ids and its active_holds contain exactly that hold id
- **AND** the equip's state_version equals the current state_version

#### Scenario: budget overflow fails explicitly

- **WHEN** the serialized fact list length exceeds the configured budget
- **THEN** equip issuance fails with equip-budget-exceeded
- **AND** a budget-exceeded event is appended and the error carries fact count, serialized length, and budget

#### Scenario: non-project-scope assets never enter facts

- **WHEN** an equip is requested with an active task-scope asset present
- **THEN** that asset does not appear in the equip's verified_facts
- **AND WHEN** an equip is requested with an active participant-scope asset present
- **THEN** that asset does not appear in verified_facts either (scope isolation)

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
