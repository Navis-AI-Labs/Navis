# Design: work-contracts

## Context

The Contracts package exists since `foundation-baseline` with transport primitives only. This change adds the first business payloads. The kernel's issued-equip shape (`IssuedEquip`) and `submitReturn` command are the semantic input; the contracts package is the sole public authority and imports no server implementation (ADR-0001). Standards selected: 00, 01, 02, 05, 06 (primary), 09.

## Decisions

### D1 — Contract authority lives in contracts; domain types are never imported

Public schemas are re-declared in `packages/contracts` (zod) even where a domain schema names the same concept. The two sides are deliberately not code-shared: the domain schema is free to evolve with kernel internals while the public contract stays frozen at its declared version. Golden fixtures pin the correspondence the public promises.

- **Rationale**: ADR-0001 dependency direction (`contracts imports no server implementation package`); public contracts outlive server internals by definition.
- **Alternatives considered**: (a) import domain schemas into contracts — rejected, violates ADR-0001 and couples public surface to internal refactors; (b) generate contracts from domain schemas — rejected, standard 06 permits generated schemas only with a non-TypeScript consumer and an ADR.

### D2 — Equip contract: full issued shape is public (θ1 adjudicated)

`id`, `state_version`, `work_id?`, `participant_id?`, `causal_snapshot`, `verified_facts`, `active_assets`, `active_holds`, `boundary?`, `acceptance_criteria?`, `allowed_actions?`, `issued_at`, `status`. The causal snapshot and hold references are part of the public contract because Bridges and Adapters act on them (staleness detection, obstruction signaling). The contract documents `allowed_actions` as descriptive-only: it records what the server permitted at issuance, the kernel is the sole grant authority, and the list never authorizes anything. The domain-object-model baseline already states `allowed_actions` is server-issued and never client-authoritative; the contract repeats that normatively.

- **Rationale**: withholding fields now would force the contract to churn at R1 exactly where stability matters most.
- **Alternatives considered**: minimal public subset (id + state_version only) — rejected as too weak to build any adapter against.

### D3 — Canonical Work Event envelope

Envelope fields fixed for v1: `schema_version` (int, 1), `event_type` (discriminator), `occurred_at`, `project_id`, `source_runtime`, `source_session_id`, `raw_ref`, `extractor_version`, `confidence` (0..1), `review_status` (`pending`/`accepted`/`rejected`).

`event_type` initial closed enum (v1): `work.started`, `work.progressed`, `work.returned`, `checkpoint.suggested`, `evidence.captured`, `candidate.proposed` — six, tracking the research pipeline's four extraction outputs plus progress and return. Adding an enum value requires raising `schema_version` per the evolution rule — a deliberately conservative choice for v1 so early consumers never see events they cannot classify.

Confidence and review status are separate fields by design: extractor uncertainty is machine data; acceptance is a human act (research threshold: extraction suggests, humans accept).

- **Rationale**: the extraction-provenance field set is the accepted minimum from the adapter research (source, session, raw reference, extractor version, confidence, review state); envelopes without provenance cannot be audited and cannot feed the candidate→acceptance chain.
- **Alternatives considered**: (a) larger event vocabulary — rejected, semantic freeze risk; (b) drop `review_status` and derive review from project state — rejected, Bridge outbox entries need to travel before server confirmation.

### D4 — Evolution: additive-only with consumer tolerance

Consumers ignore unknown fields; producers never emit undeclared fields; any removal, rename, narrowing, or new enum value raises `schema_version`. Consumers reject events with a `schema_version` above what they support, explicitly. This asymmetry is mechanical, not documentary: each contract module ships **two parse entry points** — a producer-strict validator (rejects undeclared fields) and a consumer-tolerant parser (drops undeclared fields). An unknown `event_type` at a supported version refuses rather than degrades, because a payload the parser cannot classify cannot be safely routed. This is standard 06 applied, expressed in the spec so implementations cannot drift.

- **Rationale**: private package (`v0.0.0`, unpublished) keeps the blast radius internal; the rule is still written down now because the day it is needed is after the first external consumer exists.
- **Alternatives considered**: semantic versioned package publication — rejected, out of scope and premature per research (Protocol deferred until adoption exists).

### D5 — Return result surface: conflict stays out of values, versioned rejection rides Problem Details (θ3 adjudicated)

The contract result is `{ absorbed_candidates, absorbed_effects, conflict_marked?: true }` — the flag is surfaced as data by the edge when the ledger recorded `return.conflict_marked`; stale-equip and guard rejections are Problem Details with the version-conflict profile and a stable, namespaced reason token derived from the kernel's error registry URN. **The kernel itself is not modified**: the edge discovers the conflict fact from the recorded event stream. Surfacing conflict in the kernel's return value is recorded as a possible future amendment, not part of this change.

- **Rationale**: zero domain churn keeps this change single-package and single-capability; the events already carry every fact the edge needs.
- **Alternatives considered**: add a read-back verdict field to the kernel result — rejected for this change (widens blast radius; revisitable when the API edge exists and its cost is concrete).

### D6 — Canonical Work Events never enter the kernel ledger (θ6 adjudicated)

The canonical envelope is boundary language between adapters and the serving edge. Entry into the kernel happens exclusively through commands (e.g., return submission); the kernel event vocabulary (`KERNEL_EVENT_TYPES`) stays a closed internal set. The spec's scenarios pin this separation so a future edge cannot shortcut it.

- **Rationale**: provenance-bearing external events are untrusted input, not history; the kernel's append-only ledger accepts only guard-passed commands.
- **Alternatives considered**: persist canonical events as a raw inbox ledger — rejected; the persistence `command_inbox` already owns idempotent intake, and a second intake ledger duplicates it.

## ADR decision

None. No technology selection occurs in this change; dependency direction (ADR-0001), transport profile (ADR-0003), and evolution policy (standard 06) already govern. If review overturns D5/D6, the overturn itself is the material decision and an ADR is written then.

## Risks

- **Early semantic freeze** (Canonical Work Event untested by a real adapter): mitigated by private package status and v1 conservatism (D3); the first real adapter in R1 is the planned calibration event.
- **Dual authority drift** (domain shape vs contract shape): mitigated by golden fixtures exercised in contract tests; drift fails a test, not a release.
- **`allowed_actions` misuse by future consumers**: mitigated by the normative contract text (D2) — no contract field here authorizes anything; grant authority stays with the kernel.

## Verification plan

- Per-contract unit suites: valid fixtures parse; missing provenance rejected; unknown fields dropped; unsupported versions rejected; forged lifecycle/scope/identity fields rejected; rejection shape matches the project Problem Details profile.
- `pnpm --filter @navis/contracts test` and the full `pnpm validate` gate (seven checks) must pass before tasks can be marked complete.
