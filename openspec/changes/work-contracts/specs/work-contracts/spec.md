# work-contracts Spec Delta

## Purpose

> **Capability intent** — Continuity across agents, sessions, and tools is possible only if "being equipped" and "returning work" have one public language. This capability defines the first business payloads of the Contracts package: the Canonical Work Event envelope every Adapter emits, the public shape of an issued Equip, and the Return submission contract. These schemas are the single runtime-validatable authority for those shapes; server internals are never imported to define them, and they evolve by additive change only.
> **Scope boundary** — This capability defines only: the Canonical Work Event envelope and its version/evolution rules; the public Equip contract; the public Return submission contract (request, result, rejection profile). Not included: any HTTP route or server wiring, the internal domain event ledger (kernel event vocabulary stays closed and internal), retrieval/query read surfaces, schema-change or registry contracts, and any publication of the package (it stays private until a separate decision).

## ADDED Requirements

### Requirement: the canonical work event has a versioned, extraction-attributed envelope

Every signal crossing an adapter boundary SHALL serialize as one Canonical Work Event envelope carrying: `schema_version` (positive integer, starting at 1), `event_type` (a closed enum acting as the payload discriminator), `occurred_at` (logical timestamp), and the extraction provenance fields `source_runtime`, `source_session_id`, `project_id`, `raw_ref` (pointer to the original material), `extractor_version`, `confidence` in `[0.0, 1.0]`, and `review_status` (pending / accepted / rejected — the human-review state, distinct from confidence). The payload SHALL validate per its `event_type` discriminator. Producers SHALL NOT emit unknown fields; consumers SHALL ignore unknown fields (additive-only evolution); any breaking change SHALL raise `schema_version`. An event whose `schema_version` exceeds the consumer's supported version SHALL be rejected explicitly rather than silently interpreted.

#### Scenario: a valid event validates and round-trips

- **WHEN** a producer emits a canonical work event with all required envelope fields and a payload matching its `event_type`
- **THEN** the schema accepts it and the parsed value exposes exactly the declared fields

#### Scenario: extraction provenance is mandatory

- **WHEN** an event omits `source_runtime`, `source_session_id`, `raw_ref`, `extractor_version`, `confidence`, or `review_status`
- **THEN** the schema rejects it naming the missing field

#### Scenario: unknown fields are tolerable to consumers

- **WHEN** a consumer parses an event carrying a field the known schema does not declare, from a producer at a compatible `schema_version`
- **THEN** parsing succeeds and the unknown field is dropped from the typed result rather than failing the envelope

#### Scenario: an unsupported schema version is refused explicitly

- **WHEN** a consumer receives an event whose `schema_version` is higher than the consumer supports
- **THEN** it rejects the event with an explicit unsupported-version failure instead of partially interpreting it

#### Scenario: an unknown event type is refused at a supported version

- **WHEN** a consumer receives an event whose `schema_version` is supported but whose `event_type` is not in the closed enum
- **THEN** parsing refuses it instead of routing an unclassifiable payload

### Requirement: the equip contract publishes the issued work contract shape

The issued Equip SHALL have one public runtime-validatable shape carrying: `id`, `state_version`, optional `work_id`, optional `participant_id`, `causal_snapshot`, `verified_facts`, `active_assets`, `active_holds`, optional `boundary`, optional `acceptance_criteria`, optional `allowed_actions`, `issued_at`, and `status`. The schema SHALL express `allowed_actions` as descriptive data only: its presence SHALL never be represented as conferring authorization, and contract documentation SHALL state that authorization lives elsewhere. The public shape SHALL remain stable when only the server's internal representation changes.

#### Scenario: an issued equip validates

- **WHEN** an equip fixture matching the kernel's issued shape is parsed
- **THEN** validation succeeds, exposing facts, assets, holds, and the bound state version

#### Scenario: allowed actions are descriptive, never authorizing

- **WHEN** an equip payload lists `allowed_actions`
- **THEN** the contract treats the list as a description of what was permitted at issuance, and no contract clause SHALL read it as permission granting

#### Scenario: internal refactors do not move the contract

- **WHEN** the server restructures its internal equip assembly without changing issued values
- **THEN** the contract schema and its fixtures remain valid unchanged

### Requirement: the return submission contract binds a return to its equip and version

A Return submission SHALL name its `equip_id` and the `expected_version` of the project state the work observed, MAY carry `candidates` (each a strict seed of `kind` plus optional `provenance` and `content` — callers SHALL NOT supply lifecycle or scope, both of which the server fixes), MAY carry `effects` (optional `asset_ref`, optional `description`), and MAY carry a `causal_context` snapshot for concurrency judgment; caller identity and timestamps SHALL be injected by the serving edge, never accepted from the client body. A successful submission SHALL report the counts of absorbed candidates and effects, and SHALL surface whether the submission was flagged concurrent. Rejection SHALL be expressed through the transport problem profile with a stable machine-readable reason token, without leaking server internals.

#### Scenario: a return request validates

- **WHEN** a client submits a return with equip id, expected version, and candidate and effect seeds from the declared subsets
- **THEN** validation succeeds and only the declared fields are exposed

#### Scenario: lifecycle and scope cannot be forged

- **WHEN** a candidate seed carries a `lifecycle` or `scope` value
- **THEN** the request schema rejects it, because those fields are fixed by the server

#### Scenario: identity is not taken from the body

- **WHEN** a submission body carries an actor identity or a timestamp
- **THEN** those fields are rejected as undeclared; identity and time come from the serving edge

#### Scenario: rejection uses the problem profile with a stable token

- **WHEN** a return is refused (for example a stale equip version conflict)
- **THEN** the rejection uses the RFC 9457 problem profile carrying a stable machine-readable reason token and no internal-row detail
