# intended-direction Spec Delta

## ADDED Requirements

### Requirement: Intended Direction records are immutable and separately expressed

A project SHALL maintain Intended Direction as a set of records, stored and expressed separately from History and Current State. Each record SHALL carry: `id` (uuid), `project_id` (ref Project), `title` (1–256 chars), `detail` (optional text), `status` (`proposed` | `confirmed` | `discarded`), `proposed_by` (ref Participant), `proposed_at` (logical time), and, after resolution, `resolved_by`, `resolved_at`, and `resolution_reason`. A record's descriptive fields (`title`, `detail`) SHALL be immutable after creation; the only permitted state change is the single terminal resolution. Direction records SHALL be created and changed only through append-only kernel events. A direction event MUST NOT advance `project_state_version` and MUST NOT mutate Current State directly; a confirmed direction becomes material only through subsequent explicit commands (for example, creating a Work).

#### Scenario: direction record is stored with full provenance

- **WHEN** a participant proposes a direction with title and detail at logical time T
- **THEN** an append-only event records the proposal with actor, time, and payload, and the projected record exposes `status: proposed` with `proposed_by` and `proposed_at`

#### Scenario: direction events do not advance the state version

- **WHEN** a direction event is appended to a project whose state version is N
- **THEN** the appended event's `state_version` equals N and the project's current state version remains N

#### Scenario: proposing into a terminal project is rejected

- **WHEN** a direction is proposed on a project whose status is `completed` or `archived`
- **THEN** the kernel rejects with the registry `project-not-active` error and appends nothing

### Requirement: anyone may propose, only humans resolve

Any registered participant (human or agent) on a project that is neither `completed` nor `archived` SHALL be able to propose a direction. Confirming or discarding a direction SHALL be restricted to human participants; an agent attempt SHALL be rejected with a `forbidden` error carrying zero state pollution (no event appended, no projection change). Resolution SHALL require a non-empty `resolution_reason`.

#### Scenario: agent proposes and human confirms

- **WHEN** an agent participant proposes a direction and later a human participant confirms it with a reason
- **THEN** both events are appended, and the projected record ends with `status: confirmed`, `resolved_by` = the human, and the recorded reason

#### Scenario: agent confirmation is rejected with zero pollution

- **WHEN** an agent participant attempts to confirm or discard a proposed direction
- **THEN** the kernel rejects with the registry `forbidden` error, no event is appended, and the record remains `proposed`

#### Scenario: resolution requires a reason

- **WHEN** a human confirms a direction with an empty or missing resolution reason
- **THEN** the kernel rejects with the registry `rationale-required` error and appends nothing

### Requirement: resolution is terminal

A resolved direction (confirmed or discarded) SHALL be terminal: further resolution attempts SHALL be rejected, and no transition SHALL return a resolved record to `proposed`.

#### Scenario: resolved direction cannot be re-resolved

- **WHEN** a human attempts to confirm a direction that is already confirmed
- **THEN** the kernel rejects with the registry `forbidden` error and appends nothing

### Requirement: direction queries exclude non-proposed records only on demand

The projected direction list SHALL be queryable in three views: all records, proposed-only, and resolved-only. The views MAY be realized as filters over the full projected record set; no separate query API surface is required. Every record remains queryable by id regardless of status; nothing is deleted.

#### Scenario: proposed-only view lists only open directions

- **WHEN** the project holds one proposed and one confirmed direction
- **THEN** the proposed-only view returns exactly the proposed record and the all view returns both
