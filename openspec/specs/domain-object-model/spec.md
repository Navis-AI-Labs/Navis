# domain-object-model Specification

## Purpose

> **Capability intent** — This layer defines Navis's business vocabulary: what outputs have existed in the system, who rendered which judgments and why, what is being held back by a concern, and what has been delivered. It is the data-structure landing of the judgment-history ledger (standard → evidence → conclusion → rationale) and the single authority for the shared language of every consumer (kernel, use cases, API, UI).
> **Scope boundary** — This capability defines only: object fields and their validity, the semantic constraints of acceptance judgments, the asset lifecycle state machine, and the participant registry. The field baseline takes the accepted baseline as its sole authority; this capability invents nothing locally. Not included: the Work/WorkRun transition machines (not defined by this capability), persistence mapping and SQL (persistence-ports capability), the API transport shape (contracts capability), and multi-tenancy/authentication (not defined by this capability).

## Requirements

### Requirement: shared field conventions replace a generic base model

Authority records must stay trustworthy for their entire lifetime — never silently losing who created them, when, or why they retired. All object types SHALL follow shared field conventions instead of a CRUD-style base model (no boolean deleted flag, no untyped ext column on authority records). Every registry object carries the governed base-model quartet: `created_at` (birth stamp), `deleted_at` (tombstone — instant, never boolean; null = live), `updated_at`/`updated_by` (event-derived read cache: present in the schema shape and in the row, but writable EXCLUSIVELY by the projection replay path; any command-path write is an invariant violation, and the cache is rebuildable by replay). Equip (derived, never stored) and Checkpoint (its captured_at is the birth stamp) are the two exempt types. Identifiers SHALL be time-ordered UUIDv7 (the accepted baseline declares `uuid`; UUIDv7 is the implementation choice, recorded in design); timestamps SHALL be timezone-aware instants (timestamptz at rest); actor identity SHALL be expressed exclusively as references to Participant records; actor provenance that would change over time (who last changed a record) SHALL be derivable from the event history — the stored cache is a replay-maintained convenience, not a second authority; retirement semantics SHALL be carried by the lifecycle state machine, never by a boolean soft-delete flag; extensibility SHALL live in schema-validated event payloads, never in an untyped extension column.

#### Scenario: identifiers are time-ordered

- **WHEN** two records are created at different times
- **THEN** lexicographic ordering of their UUIDv7 identifiers matches creation order

#### Scenario: deletion is a governed tombstone, never a boolean, never a hard delete

- **WHEN** inspecting any object schema's fields
- **THEN** `deleted_at` is present as a nullable instant (tombstone semantics) and no boolean `deleted` flag exists anywhere
- **AND** retirement is expressed through lifecycle transitions (deprecated/archived/purged) and/or the tombstone — hard DELETE remains unrepresentable

#### Scenario: actor provenance is derivable from events

- **WHEN** a consumer asks who created or last changed an asset
- **THEN** the answer is computed from the event history for that asset
- **AND** the stored updated_at/updated_by fields are writable only by the projection replay path (no command-path setter exists anywhere in the codebase)

#### Scenario: no mutation-tracking or passthrough fields

- **WHEN** inspecting any object schema's fields
- **THEN** no boolean deleted flag and no untyped ext/extra passthrough field exists on any authority object schema
- **AND** any attempt by a command-path writer to set updated_at or updated_by is rejected by the guard test

### Requirement: core object types follow the accepted kernel schema baseline

Every business fact, human judgment, withheld concern, and delivery promise in Navis is expressed through the accepted object model — nothing else is authoritative, and this repository does not invent its own variant of it. The system SHALL define runtime-validated schemas (zod) for the 8 core object types (Project, Work, TaskSpace, Asset, Acceptance, Delivery, WorkRun, Hold) plus the Participant registry type, exactly as the accepted research baseline specifies them. A baseline guard test SHALL fail on any deviation from the accepted baseline (extra field, missing field, missing enum value, extra enum value). Invalid construction input SHALL be rejected with a structured error naming the field and reason.

Field baseline (all enums exactly as accepted):

- **Project**: `id` (uuidv7), `title`, `purpose?` (why this project exists), `boundary?` (current effective business-boundary summary; the full history lives in Event History and is never mutated in place), `acceptance_criteria?` (array of text — project-level criteria, e.g. ["3 merchants complete onboarding"]), `status` (active/paused/completed/archived), `current_state_version` (integer — the Project State version used for concurrency and Equip invalidation; incremented only by State-material events: boundary updates, project status changes, acceptance-criteria structure changes), `created_at`, `deleted_at?` (tombstone instant, null = live), `updated_at?`/`updated_by?` (event-derived read cache; writable only by the projection replay path).
- **Work**: `id`, `project_id` (ref Project), `title`, `status` (planned/in_progress/blocked/completed/cancelled — transition machine not defined by this capability), `direction?` (current method or direction, updatable via redirect events), `acceptance_criteria?` (array of text — work-level criteria), `depends_on?` (array of ref Work — predecessor dependencies; relation rows in persistence), `created_at`, `deleted_at?` (tombstone instant, null = live), `updated_at?`/`updated_by?` (event-derived read cache, replay-writable only).
- **TaskSpace**: `id`, `created_at`, `deleted_at?` (tombstone instant, null = live), `updated_at?`/`updated_by?` (event-derived read cache, replay-writable only), `work_id` (ref Work) — exactly these five fields. A task space is the shared working context of one work. Multi-participant presence (several humans and/or agents in one space) is modeled through the Participant registry, Equip.participant_id, and WorkRun.intervention_sessions — not through a member list on the space. Task spaces have no standalone physical table.
- **Asset**: `id`, `project_id` (ref Project — required unless scope=organization; an organization-scope asset carries no project anchor), `kind` (context/knowledge/experience/skill/artifact/evidence/template), `scope` (participant/session/task/project/organization — five sedimentation levels; participant scope covers both human-private and agent-private assets, so "whose" never needs a second enum; ownership comes from provenance/events), `provenance?` (text — where this content came from), `lifecycle` (see lifecycle requirement), `content?` (object — the physical carrier: `media_type` (IANA type), `storage` (inline/object_ref/local_ref/external_ref), `ref?`, `size?`, `sha256?`; `ref` points at content stored outside the event stream — an Object Storage key, a local path reference, or an external URL — and is required for every non-inline storage while forbidden for inline, whose content lives inside event payloads; `content` absent means the content lives in event payloads rather than an independent file), `valid_from?`/`valid_to?` (reserved dual-temporal window, default null — removal requires a supersede), `created_at` (record birth stamp), `deleted_at?` (tombstone instant, null = live), `updated_at?`/`updated_by?` (event-derived read cache, replay-writable only); `quality_signals` is not a schema field — it is a runtime property and stays outside the schema.
- **Acceptance**: `id`, `target_ref`, `target_type` (Asset only — the CandidateSchemaChange type is deferred; its acceptance goes through a Registration event and the enum value may return when that type lands), `result` (accepted/rejected/conditional), `actor` (ref Participant — must be a human participant; the kernel enforces this), `rationale?` (required when result is rejected or conditional; optional on accepted), `criteria_snapshot` (JSONB — the criteria as of judgment time, required; the judgment-history ledger must be able to answer which criteria version applied), `evidence_refs?` (array of uuid, bounded at 100 — evidence relied upon at judgment time), `created_at` (record birth stamp), `deleted_at?` (tombstone instant, null = live), `updated_at?`/`updated_by?` (event-derived read cache, replay-writable only).
- **Delivery**: `id`, `created_at` (record birth stamp; the send moment is carried by `dispatched_at` and confirmation fields), `deleted_at?` (tombstone instant, null = live), `updated_at?`/`updated_by?` (event-derived read cache, replay-writable only), `asset_id` (ref Asset), `target_ref` (typed delivery target: internal object id or external URI), `target_type` (staging/production/customer_confirmation/business_process/external_system), `dispatched_at` (the send-out fact), `version` (the delivered Asset's content.sha256 anchor), `attempt_no` (positive integer, default 1 — a retry after rejection is a new attempt, not an in-place status rewrite), `confirmed_by?` (ref Participant — the responsible party who confirmed arrival), `confirmed_at?`, `confirmation_status` (delivered/confirmed/rejected/pending, default delivered — delivered=sent out, confirmed=the business side acknowledges receipt, rejected=the business side refuses, pending=awaiting confirmation), `feedback?` (post-delivery real-world feedback that can re-enter the project and trigger the next work).
- **WorkRun**: `id`, `work_id` (ref Work), `parent_run_id?` (ref WorkRun — resumption chain), `status` (ready/running/waiting_input/waiting_approval/paused/cancelling/cancelled/failed/completed — transition machine and takeover-exclusivity rules not defined by this capability), `intervention_mode?` (observe/assist/takeover), `intervention_sessions?` (array of intervention session records, bounded at 100 — each session carries participant_id, mode, started_at, ended_at, and `consent_status`), `checkpoint_id?` (ref Checkpoint — resume position), `input_state_version` (integer — the Project State version the run started from), `attempt` (positive integer, default 1), `execution_refs?` (JSONB — external execution references only: runtime/adapter/device/capability/resume_command_ref/expires_at/idempotency_key/causation_id/correlation_id; external protocol IDs are execution references, never business keys), `created_at` is the run's birth stamp; `deleted_at?`/`updated_at?`/`updated_by?` are the governed base-model fields (tombstone + event-derived cache, replay-writable only).
- **Hold**: `id`, `project_id` (ref Project), `kind` (bug/tech_debt/deferred_decision/unvalidated_assumption/known_risk/skipped_edge_case — extensible), `severity` (critical/high/medium/low/info), `status` (registered/active/resolved/accepted/dormant/invalidated — see kernel hold requirement), `fowler_quadrant?` (prudent_deliberate/prudent_inadvertent/reckless_deliberate/reckless_inadvertent — qualitative debt classification; only when kind=tech_debt), `blocks_delivery` (boolean, default false), `statement` (required text — the problem itself; the landing place for the register action's required description), `source_event_ids?` (array of event ids — the evidence this hold is grounded in), `registered_during_work?` (ref Work), `registered_by` (ref Participant — human or agent; the human confirmation fact is the activate event's actor), `asset_refs?` (array of ref Asset — a blocking hold gates delivery of these assets), `applicability?` (text — in which business phase and under which conditions this hold still applies). `created_at` (record birth stamp — when the hold was registered), `deleted_at?` (tombstone instant, null = live), `updated_at?`/`updated_by?` (event-derived read cache, replay-writable only), no `resolved_at` (status-change timeline lives in Event History).
- **Participant** (registry type): `id`, `created_at`, `project_id` (ref Project), `type` (human/agent), `display_name?`, `role?` (descriptive project role, e.g. business owner, code analyst, reviewer; authorization is a separate policy and never derives from this free-text field), `deleted_at?` (tombstone instant, null = live), `updated_at?`/`updated_by?` (event-derived read cache, replay-writable only). Participants are the system's only actor identity: every event's actor and every actor reference in the model SHALL be a Participant ref.
- **Equip** (system type — a derived projection assembled from Project State; never stored as independent business data; no physical table in any change of this repository): `id`, `state_version`, `work_id?` (ref Work), `participant_id?` (ref Participant — the equipped participant), `allowed_actions?`, `schema_snapshot_version?`, `status` (active/stale/expired). Derived payload (boundary summary, verified_facts, active_assets, active_holds, acceptance_criteria, issued_at) is assembled at generation time; `allowed_actions` is server-issued and server-checked, never client-authoritative.
- **Checkpoint** (system type — a recoverable breakpoint during work execution): `id`, `work_id` (ref Work), `reason?` (text), `captured_at` (the capture moment doubles as the birth stamp; stays quartet-exempt), `state_version` (integer — the Project State version at capture), `position?` (JSONB — the execution position to resume from), `resume_ref?` (JSONB — the external resume reference). redirect_work creates one by default before changing direction.
- **CandidateSchemaChange** (system type): deferred; `Acceptance.target_type` carries only `Asset` — CandidateSchemaChange resolution lands when that type is defined.

#### Scenario: valid object construction

- **WHEN** a valid Asset is constructed with all required fields (id, kind, scope, lifecycle=candidate, provenance)
- **THEN** construction succeeds and the parsed object exposes exactly the declared fields
- **AND** unknown extra keys are rejected

#### Scenario: invalid construction is rejected with field-level detail

- **WHEN** an Asset is constructed with lifecycle="fortnite" (not a legal enum value)
- **THEN** construction fails with an error naming the `lifecycle` field and the invalid value

#### Scenario: baseline guard rejects local inventions

- **WHEN** a proposed schema change renames a baseline field, adds a field not in the accepted baseline, or adds an enum value (e.g. a new Asset scope) without a corresponding accepted research change
- **THEN** the baseline guard test fails and names the deviation

#### Scenario: actor references resolve to participants

- **WHEN** any object with an actor reference (Acceptance.actor, Hold.registered_by, Delivery.confirmed_by) is constructed with a value that is not a registered Participant id
- **THEN** construction fails with a field-level reference error

#### Scenario: content carrier validates its storage enum

- **WHEN** an Asset is constructed with content.storage="cloud" (not inline/object_ref/local_ref/external_ref)
- **THEN** construction fails with an error naming the `content.storage` field

### Requirement: acceptance rationale is required on rejected and conditional verdicts

The judgment-history ledger compounds only when every verdict records its reason; an unexplained rejection is a lost lesson. An Acceptance with result=rejected or result=conditional MUST carry a non-empty `rationale`. result=accepted MUST allow null rationale. This is the mechanical guarantee that the judgment-history ledger captures standard→evidence→verdict→reason.

#### Scenario: rejected without rationale is rejected

- **WHEN** an Acceptance is constructed with result="rejected" and rationale undefined
- **THEN** construction fails with a field-level error on `rationale`

#### Scenario: conditional without rationale is rejected

- **WHEN** an Acceptance is constructed with result="conditional" and rationale=""
- **THEN** construction fails (empty string is not a rationale)

#### Scenario: accepted with null rationale is valid

- **WHEN** an Acceptance is constructed with result="accepted" and no rationale
- **THEN** construction succeeds

#### Scenario: conditional-to-accepted promotion keeps both judgments

- **WHEN** an asset receives a conditional Acceptance and later an accepted Acceptance
- **THEN** both Acceptance records exist as independent judgments (the judgment history is append-only at the domain layer)

### Requirement: asset lifecycle has seven states with a legal-transition table

Retirement of knowledge is a governed business process — superseded work gets a grace window, archives age 180 days, and deletion needs a human's second confirmation — never a delete button. Asset lifecycle SHALL be an enum of exactly: candidate, active, superseded, competitive_superseded, deprecated, archived, rejected. The value contested SHALL be reserved in the type but MUST NOT be reachable in any transition (reserved value; its transition semantics are not defined). A transition function SHALL accept (from, to) pairs and reject illegal ones with registry tokens from the schema module (`schema/illegal-transition`, `schema/not-enabled`, `schema/purge-conditions-unmet` — same closed, add-only registry discipline as the kernel's tokens); terminal states MUST NOT restart; archived→purged SHALL require both ≥180 days in archived and an explicit double-confirmation token.

Legal transitions (exactly the 11 pairs): candidate→active, candidate→rejected, active→superseded, active→competitive_superseded, active→deprecated, active→archived, superseded→archived, competitive_superseded→active (grace-period rollback), competitive_superseded→archived, deprecated→archived, archived→purged (double-condition). All other pairs are illegal. Notably illegal: candidate→archived (must activate before retiring), candidate→superseded / candidate→competitive_superseded (cannot be superseded before activation), active→candidate (no rollback to candidate), rejected→active, rejected→archived (rejected is terminal).

Fix-and-resubmit is NOT a lifecycle transition: a rejected record stays rejected forever (its judgment history is preserved); resubmission after fixes creates a NEW candidate asset whose provenance references the rejected predecessor. The ledger keeps both records — the rejection is a lesson, not garbage.

#### Scenario: legal transition passes

- **WHEN** transitioning candidate→active
- **THEN** the transition succeeds

#### Scenario: illegal transition is rejected

- **WHEN** transitioning candidate→archived (skipping activation) or candidate→superseded (superseding before activation) or active→candidate
- **THEN** each transition fails with an illegal-transition error

#### Scenario: rejected is terminal and resubmission creates a new candidate

- **WHEN** transitioning rejected→active, rejected→archived, or rejected→candidate
- **THEN** each transition fails (rejected is terminal)
- **AND WHEN** a fixed deliverable is resubmitted after a rejection
- **THEN** a new candidate asset is created whose provenance references the rejected predecessor
- **AND** the rejected record and its verdict rationale remain in the ledger unchanged

#### Scenario: terminal state cannot restart

- **WHEN** transitioning archived→active
- **THEN** the transition fails

#### Scenario: purge requires both conditions

- **WHEN** an asset has been archived 100 days (below threshold) with double confirmation given
- **THEN** archived→purged fails
- **AND WHEN** the asset has been archived 200 days but double confirmation is absent
- **THEN** archived→purged fails
- **AND WHEN** the asset has been archived 200 days and double confirmation is present
- **THEN** archived→purged succeeds

#### Scenario: contested is reserved, not reachable

- **WHEN** any transition targets lifecycle=contested
- **THEN** the transition fails with a not-enabled error (contested transitions are not enabled)

#### Scenario: superseded rollbacks

- **WHEN** transitioning active→superseded
- **THEN** the transition succeeds
- **AND WHEN** transitioning superseded→active
- **THEN** the transition fails (superseded is terminal-active; only competitive_superseded has a grace-period rollback)
