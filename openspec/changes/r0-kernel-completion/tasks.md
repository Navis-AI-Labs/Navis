# Tasks — r0-kernel-completion

Standards selected: `01-source-code`, `02-testing`, `03-errors-and-observability`, `04-security`, `06-contracts-and-compatibility`, `07-data-and-persistence`, `08-concurrency-and-reliability`.

## 1. Intended Direction (requirement: intended-direction spec)

- [x] 1.1 Add `src/schema/intended-direction.ts` (fields per spec; strictObject; guarded-quartet conventions) + schema-baseline guard cases. Verifies field-baseline requirement. Standard: 01, 06. Verification: `pnpm test -- schema-baseline`.
- [x] 1.2 Add events `direction.proposed` / `direction.resolved` to the closed vocabulary (add-only) + exhaustive scan update. Standard: 06. Verification: `pnpm test -- state-events state-kernel`.
- [x] 1.3 Add kernel commands `proposeDirection` / `resolveDirection` with human-only resolve, mandatory resolution reason, terminal resolution, non-State-material version behavior (events repeat the current state version), zero-pollution rejections, and the derived three-view semantics (filters over the projected set, no separate query surface). Standards: 01, 04. Verification: `pnpm test -- intended-direction state-kernel`.
- [x] 1.4 New `test/intended-direction.test.ts` covering every scenario in the spec. Standard: 02. Verification: `pnpm test -- intended-direction`.

## 2. WorkRun transition machine (requirement: workrun-execution spec — transitions)

- [x] 2.1 Transcribe the legal transition table from this change's `workrun-execution` spec into `WORKRUN_TRANSITIONS` + `assertWorkRunTransition` in `src/schema/workrun.ts` (pure function, reuse `schema/illegal-transition`). Standard: 01. Verification: `pnpm test -- state-workrun`.
- [x] 2.2 Add events `workrun.started` / `workrun.transitioned` (closed vocabulary, add-only). Standard: 06. Verification: `pnpm test -- state-events`.
- [x] 2.3 Add kernel commands `startRun` / `transitionRun`: gate evidence checks (equip version, input, approval [human-only], resume checkpoint), mandatory reason, run-revision optimistic concurrency (transition commands carry the run's expected revision; every run event advances it by exactly 1 — sessions included). Standards: 01, 04, 08. Verification: `pnpm test -- state-workrun`.
- [x] 2.4 New `test/state-workrun.test.ts`: 16 legal pairs, illegal pairs incl. all terminals, gates, audit fields, replay identity. Standards: 02, 08. Verification: `pnpm test -- state-workrun`.

## 3. Intervention concurrency (requirement: workrun-execution spec — intervention)

- [x] 3.1 Add `src/state/intervention.ts`: multi-read-one-write manager as a standalone module consumed by the kernel (observe/assist parallel, takeover exclusive + prerequisite session, derived strongest-active-mode) + events `intervention.session_opened/closed` (`pending` consent on open). Standards: 01, 08. Verification: `pnpm test -- state-intervention`.
- [x] 3.2 Kernel commands `openIntervention` / `closeIntervention` (both carrying the run's expected `run_revision`): close records the terminal `consent_status` (granted | denied) for assist/takeover sessions; takeover close sets `re_equip_required`; resuming commands on a released run must present a fresh equip issued at the current state version (the release re-equip gate). Standards: 01, 04. Verification: `pnpm test -- state-intervention state-workrun`.
- [x] 3.3 New `test/state-intervention.test.ts`: parallel sessions, double takeover, no-presence takeover, consent lifecycle (pending → terminal granted/denied on close), stale-equip rejection, fresh-equip resume, replay identity. Standards: 02, 08. Verification: `pnpm test -- state-intervention`.

## 4. Persistence (requirement: both new capabilities)

- [x] 4.1 Edit `migrations/001_events.sql` in place (pre-production: no compatibility layering): add `intended_directions` + `workruns` projection tables (FK, tombstone column, CHECK >= created_at). Standards: 07. Verification: `pnpm test -- postgres-wire-unit` (+ integration with DATABASE_URL).
- [x] 4.2 Extend `postgres-wire-unit.test.ts` to assert the enlarged 001 schema (new tables, tombstone columns, CHECK constraints). Standard: 07. Verification: `pnpm test -- postgres-wire-unit in-memory-event-store`.

## 5. Whole-change gates

- [x] 5.1 Kernel surface scan extended: no update/delete API on direction records, run rows, or session ledgers; appended events frozen. Standard: 02. Verification: `pnpm test -- state-kernel`.
- [x] 5.2 Full gate: `pnpm validate` (format, build, lint, typecheck, boundaries, tests, coverage 100%, openspec validate --strict). Verification: exit 0.
- [x] 5.3 Lab-spec simulation battery: exhaustive 81-pair transition table, revision-conflict races, equip-churn matrix with release freshness anchoring, 12-session intervention storm, 30-record direction load, checkpoint-theft gate, full business-day walkthrough, seeded randomized property runs (10 seeds x 200 steps + 1000-step scale; replay identity, zero-pollution on rejection, revision and state-version conservation, and ledger integrity asserted after every step). Standard: 02, 08. Verification: `pnpm test -- state-simulation`.
- [x] 5.4 Storage read-cache conformity: baseline `effect_ledger` gains the `updated_at`/`updated_by` replay-writable columns its projection rows already write (`touch(d.effects)`), matching the mutable-row convention the new tables follow; wire-unit assertion pins the columns. Standard: 07. Verification: `pnpm test -- postgres-wire-unit`.
