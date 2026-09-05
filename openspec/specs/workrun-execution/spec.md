# workrun-execution Specification

## Purpose

> **Capability intent** — The WorkRun is where AI labor happens under human supervision. Its lifecycle follows an adopted legal transition table (16 pairs, terminal states have no exits); every gated resumption demands its condition evidence (input provided, human approval, or the run's own latest checkpoint); every run event advances a per-run optimistic-concurrency revision; and intervention follows multi-read-one-write concurrency — observe and assist in parallel, exclusive takeover behind a presence precondition, a consent ledger per session, and a release that forces a fresh Equip before the run resumes.
> **Scope boundary** — This capability defines only: the single-run lifecycle inside the kernel — states, transition legality, gate evidence, run_revision concurrency, intervention sessions and consent, and the release re-equip gate. Not included: checkpoint context rebuild beyond the state-version anchor (open question OQ-25), multi-agent takeover arbitration beyond first-come-first-served, cross-run orchestration, transport or UI surfaces, and the authorization system beyond the kernel's human-role checks.

## Requirements

### Requirement: WorkRun lifecycle follows the adopted legal transition table

A WorkRun SHALL advance only through the legal transition pairs: `ready→running`; `running→waiting_input|waiting_approval|paused|cancelling|completed|failed`; `waiting_input→running|paused|cancelling`; `waiting_approval→running|paused|cancelling`; `paused→running|cancelling`; `cancelling→cancelled`. Terminal states (`cancelled`, `failed`, `completed`) SHALL have no outgoing transitions. An attempt at any other pair SHALL be rejected with the existing `schema/illegal-transition` registry token (same meaning as asset transitions; no new token), and no event. WorkRun transition events MUST NOT advance `project_state_version`.

A run's `run_revision` SHALL start at 1 when the run starts and advance by exactly 1 on every subsequent event of the run (transitions and intervention sessions alike). Run-mutating commands (transitions and intervention session commands) SHALL carry an expected `run_revision`; a stale value SHALL be rejected with the registry `version-conflict` error.

#### Scenario: every legal pair passes

- **WHEN** each legal pair from the table is executed in turn on a run in the source state
- **THEN** each transition succeeds, appends a run event, and advances the run's own revision by exactly 1

#### Scenario: every illegal pair is rejected

- **WHEN** each pair outside the table is attempted (including any transition out of `cancelled`, `failed`, or `completed`, and `cancelling→running`)
- **THEN** the kernel rejects with `schema/illegal-transition`, no event is appended, and the run state is unchanged

#### Scenario: stale expected revision is rejected

- **WHEN** a transition is attempted with an expected run revision older than the run's current revision
- **THEN** the kernel rejects with the registry `version-conflict` error and appends nothing

### Requirement: starting a run requires an equip issued at the current state version

`ready→running` SHALL require, in addition to the transition audit fields: an equip reference whose `state_version` equals the project's current state version and whose `participant_id` equals the acting participant. A missing, stale, or foreign equip SHALL be rejected with the registry `forbidden` error and no event.

#### Scenario: starting with a current equip succeeds

- **WHEN** a run is started with an equip issued to the acting participant at the current state version
- **THEN** the transition succeeds and the run's revision becomes 1

#### Scenario: starting with a stale equip is rejected

- **WHEN** a run is started with an equip bound to an older state version
- **THEN** the kernel rejects with the registry `forbidden` error and appends nothing

### Requirement: gated resumptions require their condition evidence

A `waiting_input→running` transition SHALL require `input_provided` evidence; a `waiting_approval→running` transition SHALL require an `approval_result` supplied by a human participant; a `paused→running` transition SHALL require a `resume_checkpoint_id` reference naming the run's last recorded checkpoint. A transition into `paused` SHALL record a checkpoint for the run — carrying the project's current state version as the recovery anchor and optional position/resume_ref payloads — so that the resumption gate is always satisfiable; the run row SHALL record the checkpoint reference. Missing gate evidence SHALL be rejected without appending an event.

#### Scenario: approval gate blocks until approval result is supplied

- **WHEN** a `waiting_approval→running` transition is attempted without an `approval_result`
- **THEN** the kernel rejects with the registry `forbidden` error and the run stays `waiting_approval`

#### Scenario: pausing records a resumable checkpoint

- **WHEN** a `running→paused` transition is executed with optional position and resume_ref payloads
- **THEN** a checkpoint is recorded with the project's current state version as anchor, the run row references it, and a later `paused→running` transition succeeds by referencing it

#### Scenario: approval result from an agent does not open the gate

- **WHEN** an agent participant supplies the `approval_result` for a `waiting_approval→running` transition
- **THEN** the kernel rejects with the registry `forbidden` error (approvals are human-only) and appends nothing

### Requirement: every transition is audited

Every WorkRun transition SHALL be appended as an event carrying: actor (ref Participant), reason (non-empty), the gate evidence when applicable, the run's expected revision, and the logical time. A transition without a reason SHALL be rejected with the registry `rationale-required` error.

#### Scenario: transition without a reason is rejected

- **WHEN** a legal transition is attempted with an empty or missing reason
- **THEN** the kernel rejects with the registry `rationale-required` error and appends nothing

### Requirement: intervention concurrency is multi-read-one-write

While a WorkRun is executing, observe and assist sessions MAY run in parallel without limit. Takeover SHALL be exclusive: at most one active takeover session MAY exist, and a takeover SHALL be permitted only when the taking participant holds an active observe or assist session on the run (a participant cannot take over without first being present). Assist and takeover sessions SHALL record `consent_status`: a session opens as `pending`, and its terminal value (`granted` | `denied`) is recorded when the session closes; observe sessions need no consent (read-only). Every session SHALL record `participant_id`, `mode`, `started_at`, and, when it ends, `ended_at`.

Only the session's owner, a takeover holder releasing their own session, or a human participant MAY close a session. Closing an assist or takeover session SHALL record the session's terminal `consent_status` (`granted` | `denied`); closing a takeover session SHALL additionally set the run's `re_equip_required` flag.

#### Scenario: parallel observers and assistants coexist

- **WHEN** three participants hold observe sessions and two hold assist sessions on the same running WorkRun
- **THEN** all five sessions are active concurrently and each is recorded with its actor and start time

#### Scenario: double takeover is rejected

- **WHEN** a second takeover is attempted while an active takeover session exists
- **THEN** the kernel rejects with the registry `forbidden` error and no session is recorded

#### Scenario: takeover without prior presence is rejected

- **WHEN** a takeover is attempted by a participant with no active observe or assist session on the run
- **THEN** the kernel rejects with the registry `forbidden` error and no session is recorded

#### Scenario: closing another participant's session is rejected

- **WHEN** a participant attempts to close an active session owned by a different non-takeover participant without being a human participant
- **THEN** the kernel rejects with the registry `forbidden` error and the session stays open

#### Scenario: closing an assist session records its terminal consent

- **WHEN** an assist session that opened as `pending` is closed by an authorized actor with `consent_status: granted`
- **THEN** the recorded session ends with `ended_at` set and the terminal `consent_status` `granted`

### Requirement: takeover release forces a fresh Equip

While a run's `re_equip_required` flag is set, every run-resuming command MUST present a fresh Equip issued at the current project state version to the acting participant; continuing on the pre-takeover Equip SHALL be rejected with the registry `forbidden` error. The first successful resuming command clears the flag. The released run MAY resume from the last recorded checkpoint; checkpoint-context rebuild beyond this remains out of scope of this capability.

#### Scenario: continuing on a stale equip after takeover release is rejected

- **WHEN** the takeover session ends and a run-resuming command arrives referencing the equip issued before the takeover
- **THEN** the kernel rejects with the registry `forbidden` error and the run does not advance

#### Scenario: fresh equip resumes the run

- **WHEN** a fresh equip is issued at the current state version and the resuming command presents it
- **THEN** the transition (for example `paused→running`) succeeds and the re-equip fact is recorded in the event

### Requirement: intervention and run events are append-only and agent-signed

Intervention session events and WorkRun transition events SHALL be append-only kernel events carrying the acting Participant id. No API SHALL offer update or delete on them, and replay SHALL reconstruct the session ledger and run history identically.

#### Scenario: replay reconstructs sessions and run history

- **WHEN** the event log of a run containing sessions, takeovers, releases, and transitions is replayed from scratch
- **THEN** the reconstructed session ledger and run history are canonically identical to the pre-replay projection
