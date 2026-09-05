# Design — r0-kernel-completion

## Selected standards

`01-source-code` (always), `02-testing`, `03-errors-and-observability` (audit events), `04-security` (human-only authorization semantics), `06-contracts-and-compatibility` (closed event vocabulary, add-only), `07-data-and-persistence` (new migration), `08-concurrency-and-reliability` (multi-read-one-write, optimistic revisions).

## D1 — Requirement coverage

Every behavior introduced by this change is defined normatively by this change's two delta specs (`specs/intended-direction/spec.md`, `specs/workrun-execution/spec.md`). The transition table, gate evidence names, audit fields, concurrency rules, and the release re-equip gate are transcribed there in full — the specs are self-contained and no external document is required to implement or verify them. Provenance of each rule (which upstream research or decision document it came from) is tracked outside this repository and is not repeated here.

## D2 — Event vocabulary (add-only extension)

Six new closed event types appended to the kernel's event-type list:

- `workrun.started` / `workrun.transitioned` — payload: `run_id`, `work_id`, `from`, `to`, `reason`, actor via envelope, gate evidence fields when applicable (`input_provided` | `approval_result` | `resume_checkpoint_id`), post-event `run_revision`.
- `intervention.session_opened` / `intervention.session_closed` — payload: `run_id`, `session_id`, `mode`, `consent_status?` (`pending` on open; terminal `granted` | `denied` recorded on close), `was_takeover?` (close payload only, drives the release re-equip flag), actor via envelope.
- `direction.proposed` / `direction.resolved` — payload: `direction_id`, `title`, `detail?`, and on resolve `resolution` (`confirmed` | `discarded`) + `resolution_reason`.

A `→paused` transition reuses the existing `checkpoint.created` event (run checkpoints carry `run_id`, the state-version anchor, and optional position/resume_ref) — no additional event type for checkpoints. Run checkpoints extend the existing checkpoint projection rows with an optional `run_id` reference.

None of these are State-material: replay repeats the current `project_state_version` (per the specs' version-neutrality scenarios). Run creation has no separate event: the first `workrun.started` brings the run into existence from `ready`; `run_id` is supplied by the caller like other aggregate ids.

## D3 — Kernel surface

- `startRun(cmd)` — `ready→running` gate: requires actor + equip reference issued at the current state version to the acting participant. Rejects with `forbidden` when the equip is missing, stale against the current state version, or foreign.
- `transitionRun(cmd)` — table check via `assertWorkRunTransition(from, to)`; reason mandatory (`rationale-required`); gate evidence checks; optimistic concurrency on the run's `run_revision` (`version-conflict`); approval gate human-only.
- `openIntervention(cmd)` / `closeIntervention(cmd)` — concurrency-manager rules per spec; both carry the run's expected `run_revision` (version-conflict on stale); close records the terminal `consent_status` for assist/takeover sessions, closes by owner / takeover-holder-self-release / human-only for third parties, and closing a takeover session sets `re_equip_required` on the run.
- `proposeDirection(cmd)` / `resolveDirection(cmd)` — resolve is human-only (`forbidden` for agents), reason mandatory (`rationale-required`), resolution terminal; proposing is rejected only in terminal project statuses (`project-not-active` when `completed` or `archived`; paused projects accept proposals — planning does not mutate state).
- All rejections reuse existing tokens: `kernel/forbidden`, `kernel/rationale-required`, `kernel/version-conflict`, `kernel/project-not-active`, `schema/illegal-transition`. Zero registry additions.

## D4 — Projection and storage

- Run rows: `run_id` → `{ work_id, status, run_revision, intervention_sessions[], checkpoint_id?, re_equip_required? }` held in the kernel projection like other aggregates — field names mirror the baseline `workRunSchema` (`run_revision` joins it as the optimistic-concurrency token clients echo back); sessions persist in the baseline `intervention_sessions` relation table (L5), keyed by `work_run_id`. Query pressure is a later concern; a relation table is not created until a consumer needs one — an empty-shell table would manufacture the appearance of data without any.
- Pre-production ruling (owner, 2026-09-03): no backward-compatibility migration layering. `migrations/001_events.sql` is edited in place to add the projection tables `intended_directions` (project-scoped) and `work_runs` (work-scoped; the project is reached through its work), both with the `deleted_at` tombstone column and `CHECK (deleted_at IS NULL OR deleted_at >= created_at)`; mutable rows carry the baseline `updated_at`/`updated_by` replay-writable read-cache columns (`intended_directions` included; baseline `effect_ledger` completed to match; `checkpoints` are immutable anchors and carry none). No INSERT-only trigger on projection tables — they are replay-owned; the event ledger remains the only authority.
- Wire-unit tests assert the enlarged 001 schema directly (table shapes, tombstone columns, CHECK constraints); the fresh/match/drift branches of the checksum-guarded runner keep exercising the single edited migration.

## D5 — Scenario→test mapping

- `intended-direction.test.ts`: propose/confirm/discard/agent-resolve-rejected/zero-pollution/re-reject/no-state-version-advance/non-active rejection/views.
- `state-workrun.test.ts`: 16 legal pairs with revision bumps, representative illegal pairs incl. all three terminal states, stale-revision rejection, gate-missing rejections, agent approval rejected, stale-equip start rejected, no-reason rejected, replay identity.
- `state-intervention.test.ts`: parallel observe/assist, double takeover, takeover without presence, consent lifecycle (pending on open, terminal granted/denied on close), session-close authority, release → stale-equip rejection, fresh-equip resume, replay identity.
- Existing suites updated: kernel surface scan (no update/delete on new aggregates), schema-baseline field guard for `intended-direction.ts` fields, `postgres-wire-unit.test.ts` enlarged-001 schema assertions, event-type exhaustive scan (new total after the six additions).

## D6 — Risks / notes

- The release re-equip gate is enforced as a command gate (present a new equip), not by mutating the old equip: equips are derived records, the run row records `re_equip_required`, and replay reproduces the flag.
- Run/intervention/direction events extend the closed event list; the exhaustive-scan test pattern is reused with the new total.
- No ADR required: no new technology, no boundary change; dependency direction unchanged (domain-internal, infrastructure only adds SQL).
