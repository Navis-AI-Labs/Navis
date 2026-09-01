# Design: add-r0-kernel-foundation

## Context

The repository has an archived foundation: pnpm workspaces, TypeScript 5.9.3 strict via project references, vitest+coverage, dependency-cruiser boundary enforcement, and a business-neutral `@navis/contracts` package (zod 4.4.3). ADR-0001 fixes dependency direction (domain imports nothing Navis; infrastructure implements domain/application ports). No business behavior is admitted yet. The research repo supplies the accepted semantic source: the kernel proposal (object types, Equip/Return, Hold, delivery gate), the acceptance rationale rule (symmetric reject/conditional), the invariant rules, and the verified T1-T26 simulation suites whose assertions this change ports into vitest.

Deployment requirement: Supabase is a probable deployment target but MUST NOT become an architectural dependency; self-hosted PostgreSQL must remain equally first-class. The kernel is event-sourced; its storage needs are narrow (append-only event rows, version-guarded appends, snapshot rows) which keeps engine choice cheap.

## Goals / Non-Goals

**Goals:**

- Domain object model (8 types) as zod schemas with field-level semantic comments.
- Project-state kernel: append-only frozen event history, versioned projection rebuilt by replay, optimistic concurrency, boundary/hold/equip/return/delivery semantics per the kernel spec.
- Engine-neutral EventStore port (domain) + Postgres-wire adapter (infrastructure) + in-memory adapter (infrastructure, tests).
- 100% of T20-T26 behavior assertions re-expressed as vitest suites over the real domain code (the simulation scripts were the prototype; this code is the product).

**Non-Goals:**

- HTTP/API surface, Actions use-case layer (accept_asset etc. as application use cases), WorkRun transition machine, UI, Equip generation service, auth — later changes.
- Any Supabase SDK / RLS / Edge Function / Storage usage in core code.
- Dual-temporal queries (valid_from/valid_to reserved, inert), contested lifecycle transitions, strength computation (fields reserved per the research repository's implementation-plan field rows).
- Multi-project transactionality across aggregates.

## Standards selected for this change (per docs/standards/00-index.md matrix)

- `01-source-code.md` — every task (architecture, code philosophy, naming).
- `02-testing.md` — schema/lifecycle/kernel tests; baseline guards as invariant tests.
- `03-errors-and-observability.md` — closed error registries (`kernel/`, `schema/` URNs).
- `06-contracts-and-compatibility.md` — zod schemas as the single source of truth; registry tokens as stable machine identifiers.
- `07-data-and-persistence.md` — event-store port, plain SQL migrations, INSERT-only trigger.
- `08-concurrency-and-reliability.md` — optimistic version guard; idempotent migrations.
- `10-performance-and-resources.md` — uuidv7 hot path; bounded arrays on every schema.

## Decisions

### D1 — Storage abstraction: PostgreSQL wire protocol as the primary; no platform SDK in core

The EventStore port (domain) has zero driver types. The primary adapter uses `postgres` (postgres.js) — a pure wire-protocol driver. Supabase, Neon, RDS, self-hosted, and local Docker Postgres are all "a connection string" from the kernel's perspective.

- _Alternatives_: (a) Supabase JS SDK as primary — rejected: platform lock-in in core, breaks self-hosted deploys, vendor API churn risk (Terraform/OpenTofu fork precedent: state format lock-in outlives vendor goodwill); (b) Prisma/Drizzle ORM — rejected for this layer: event rows are opaque JSONB with narrow access patterns; an ORM buys nothing and adds schema-mapping weight; (c) raw `pg` driver — viable but postgres.js has cleaner typed SQL and no callback legacy. RLS is explicitly NOT the authorization layer: authorization is a domain concern (invariant rule 8 checks live in the kernel), RLS may later be added as defense-in-depth per deployment, but no behavior may depend on it.
- _Evidence_: ADR-0004 deferred runtime selection to gates; this decision is the persistence gate outcome. New ADR-0005 records it (task T9).

### D2 — zod for domain schemas (not typebox/valibot/plain TS types)

`@navis/contracts` already depends on zod 4.4.3; the runtime-schema need is identical (validate, derive TS types, structured field-level errors). Plain TS types give zero runtime guarantee — the kernel's adversarial surfaces (agent-submitted payloads) need runtime validation. `.meta({ id })` naming follows the contracts package precedent. Domain defines its own schemas (no import from contracts — contracts is transport-shaped).

- _Evidence_: docs/standards/06 (public schemas as zod) and 04 (input validation) apply.

### D3 — Kernel shape: class-based aggregate with frozen event list + replayable projection

Matches the verified T24/T25/T26 mini-kernel shape, hardened: events frozen at append (Object.freeze deep on data), no update/delete methods, `rebuildProjection()` used by integrity checks and tests, canonical-JSON comparison for replay equality. Logical time is caller-supplied (`at`), keeping the kernel deterministic for tests (no hidden clock).

- _Alternatives_: (a) pure functions over event arrays — rejected: aggregate identity and encapsulation of the append guard are clearer as a class; (b) external event-store library (@eventstore/db-client etc.) — rejected: platform coupling, the semantics are 300 lines, not worth a dependency.

### D4 — Package layout and boundaries

```
packages/domain/src/
  schema/           # table structures only: one self-contained file per object type
                    # (asset.ts carries its lifecycle table and purge constant) + ids/text/time primitives
  errors/           # per-module closed error registries (schema.ts now; kernel.ts with task 4.2)
  state/            # (later task group) event envelope, ProjectStateKernel, delivery-gate
  ports/            # (later task group) EventStore port, ClockPort (interfaces only)
packages/infrastructure/src/
  persistence/
    in-memory/      # InMemoryEventStore
    postgres/       # PostgresEventStore + migrations/*.sql (plain SQL, idempotent)
```

`state/` and `ports/` are created with their task groups, not as placeholder
directories (AGENTS.md forbids placeholder code directories).

dependency-cruiser: domain must import no Navis package; infrastructure may import domain; both new units must pass `pnpm boundaries`.

### D5 — Shared field conventions replace a generic base model

Mutable-row CRUD convention bundles every table with created_at/updated_at, a soft-delete flag, an untyped extension column, and implicit persistence hooks. That convention optimizes for rows that change in place. Navis is event-sourced: rows never mutate, so updated_at/soft-delete/updated_by would be second sources of truth that drift from the ledger. Adopted (aligned to the accepted kernel schema baseline): identity field `id` as time-ordered UUIDv7 (the baseline declares plain uuid; UUIDv7 is the implementation choice — monotonic time-prefix ordering without an external ID-generation service), timestamptz instants, actor identity expressed exclusively as Participant refs (the accepted baseline's registry type — no bare actor-id strings), event-payload JSONB instead of an ext column, lifecycle transitions instead of a deleted flag. The baseline stores no creation-actor columns on core objects (creation provenance is derived from the first event); only Hold.registered_by / registered_during_work, Delivery.confirmed_by, Acceptance.actor, and WorkRun.participant_id exist, exactly as the baseline defines them. Negative assertions (no updated_at / deleted / ext on any schema) are spec scenarios with matching vitest guard tests. Base-model fields exist by product-owner direction — create, read, update, AND delete — under a governed mechanism: every registry object carries the governed base-model quartet: created_at (birth stamp), deleted_at (tombstone — nullable instant, never a boolean; set = retired, null = live), and updated_at/updated_by (event-derived read cache: present in the schema shape and in the row, but writable EXCLUSIVELY by the projection replay path — any command-path write is an invariant violation; if the cache ever drifts it is rebuildable by replay and therefore harmless). Equip (derived, never stored) and Checkpoint (its captured_at is the birth stamp) are the two intentional exemptions. Hard DELETE remains unrepresentable: the tombstone is instant semantics with ledger-anchored retirement, and event-layer immutability (5.x) still rejects physical row deletion. Negative assertions are: no deleted boolean, no untyped ext on any schema, and no command-path setter for updated_at/updated_by — each a spec scenario with a matching vitest guard test.

- _Alternatives_: adopt the base struct verbatim — rejected: double truth on deletion and provenance, untyped column undermines field governance; per-object creation-actor columns beyond the baseline — rejected: un-accepted local invention; creation provenance stays event-derived (the baseline's choice, and it keeps the schema smaller).
- _Reserved fields are baseline, not invention_: Asset.valid_from/valid_to and quality_signals are part of the accepted baseline — present in schema, default null, no behavior reads them. Do not remove them in the name of minimalism; they are the accepted baseline's forward-compatibility anchors.

### D14 — Version semantics are four distinct concepts

One `current_state_version` field cannot simultaneously be the event counter ("version equals event count" acceptance wording), the per-boundary-update counter (kernel proposal), the per-state-changing-event counter (kernel spec), and the replay cursor. The split:

- `project_events.seq` — per-project global event sequence (1-based, monotonic); `UNIQUE(project_id, seq)` carries optimistic concurrency at the storage layer;
- `aggregate_revision` — per-sub-aggregate (Work/Asset/Hold/WorkRun/Delivery) revision, +1 with each event of that aggregate;
- `project_state_version` — Project state version, incremented ONLY by State-material events (boundary update, project status change, acceptance-criteria structure change); `update_boundary` is one trigger among several, not the only one;
- projection cursor (`last_event_seq` on the project row) — the replay/consumption cursor, rebuildable, not a semantic field.

Consequences: `redirect_work` appends an event and bumps the Work aggregate revision while `project_state_version` stays unchanged. The acceptance standard: event seq is contiguous, and project_state_version advances only via State-material events. Equip invalidation keys on `project_state_version`; WorkRun concurrency and Return version checks use the aggregate revision plus `project_state_version` as a dual anchor. Equip budget/constant governance unchanged (D8).

- _Alternatives_: rename to `boundary_version` — rejected: too narrow, drops the project-level concurrency anchor; single field + comment — rejected: four consumers (concurrency, Equip, projection, audit) cannot share one variable without drift.

### D15 — Accepted field baseline

Applied in tasks 3.x:

- Project's need field is `purpose` (schema-layer domain neutrality);
- Hold carries `statement` (required — the problem itself; the landing place for the register action's required description) and `applicability` (when/where the hold still applies, kept distinct from Asset validity); the header comment states the three-field split (statement = what, source_event_ids = why, applicability = when/where);
- Acceptance: `target_type` is Asset-only (the deferred CandidateSchemaChange type is accepted through a Registration event, not directly; the enum value may return in a later change); `criteria_snapshot` (JSONB — the criteria as of judgment time; without it the judgment-history ledger cannot answer "which criteria version applied") and `evidence_refs` (uuid array ≤ 100);
- Delivery: `dispatched_at` (delivered = sent out; semantics pinned in the spec), `target_ref` (typed ref: internal object id or external URI), `version` (= delivered Asset content.sha256 anchor), `attempt_no` (retry after rejection is a new attempt, not an in-place status rewrite);
- Checkpoint: `captured_at` plus `state_version`, `position`, `resume_ref` — recovery needs a position, not just a moment; stays quartet-exempt;
- WorkRun carries `parent_run_id`, `input_state_version`, `attempt`, `checkpoint_id`; external execution references (runtime/adapter/device/capability/resume_command_ref/expires_at/idempotency_key/causation_id/correlation_id) live in one `execution_refs` JSONB field (external protocol IDs are execution references, not business keys); intervention sessions carry `consent_status`;
- WorkRun/TaskSpace/Checkpoint rows are projections of the run/execution layer in R0: TaskSpace keeps its schema but no standalone table; no physical Equip table exists in any phase of this change;
- `uuidSchema` splits: Navis-owned ids validate as full UUIDv7 (RFC 9562 version+variant bits); external system references use an opaque `external_ref` schema — one loose regex no longer serves both;
- Asset carries `project_id` with a cross-field rule: required unless scope=organization (the cross-project ownership rule is registered as research OQ-49, DEC-0009 — not decided in this change);
- Asset.valid_from/valid_to stay reserved-inert; removal would require a supersede, never a silent drop.

The physical PostgreSQL design (layered L1 ledger / L2 fact rows / L3 projections / L4 read models / L5 relation tables / L6 ephemeral; relation tables for work_dependencies, hold_source_events, hold_assets, intervention_sessions, delivery_attempts, workrun refs; effect_ledger and command_inbox as delivery-gate authority; partial indexes for the gate query; event_retention_marks for retention classes; INSERT-only trigger; RLS as defense-in-depth only) lands in task 5.2's migration SQL.

### D6 — Composition roots assemble adapters explicitly; no placeholder wiring

This change has no HTTP/worker entrypoint, so there is nothing to wire yet. The in-memory EventStore is constructed directly in tests; the Postgres adapter is constructed by an explicit connection factory. When api/worker changes arrive, their composition roots (the only place allowed to import domain+infrastructure+contracts together) assemble dependencies manually. This records the intent so "which DI/container" is answered by "none, by design", not left ambiguous.

### D7 — DTO/VO and validation: zod-first, one validation authority

A common web layout separates request DTO structs carrying validation-annotation metadata, response VO structs, and a standalone validator utility that converts validation failures into field-level results. Navis collapses this: zod schemas ARE the validation AND the type source (no second validation DSL), DTO = request zod schemas, VO = response zod schemas, both living in contracts when the API change admits HTTP. Field-level error extraction is native (zod issues carry field path + code); the API layer maps issues to the existing RFC 9457 problem-details schema in contracts. No validator utility package, no decorator/class-validator style second system.

- _Alternatives_: adopt a validator-annotation DSL alongside schema types — rejected: two validation languages drift; hand-rolled field-error wrapper — rejected: duplicates zod issue data.

### D8 — Error codes and tuning constants are closed, namespaced, add-only registries (multi-module scale)

Navis is a multi-module system; error codes and tuning constants are contracts shared across modules and must be governed as such, not sprinkled as literals.

Error-code mechanism (per module):

- Each module owns one closed registry of stable kebab-case string tokens (kernel: `forbidden`, `rationale_required`, `version_conflict`, `equip_budget_exceeded`, `unaccepted_artifact`, `blocking_hold`, `unknown_effect_unclosed`, `project_cancelled`, `boundary_violation`, ...).
- A single `defineRegistry(module, tokens)` helper freezes the token map, derives the typed key union, and produces the external URN form `<module>/<token>` (e.g. `kernel/version_conflict`) — the URN is the stable cross-module/transport contract and maps 1:1 onto RFC 9457 problem-details `type` later.
- Namespace rule: `<module>/` prefixes are unique across the system; two modules cannot emit the same URN (checked by the central module registry).
- Enum governance boundary (fixed for all later changes): closed enums are for internal state machines only — their consumers live in this repo and value additions ship as same-repo changes. Cross-boundary machine identifiers (error URNs, schema meta ids) are governed as closed, add-only contracts; human-language fields (role, validity, provenance) stay free text — an organization's vocabulary must never be frozen into an enum. Extending an enum that outside consumers switch over is, by definition, a breaking change and must ship as a contract-versioned change.
- Evolution: registries are add-only — renaming or reusing a token for different meaning is a breaking contract change and forbidden; retiring a token requires a deprecation window (kept as `@deprecated` entries that still resolve).
- Domain error objects carry `{ code, details? }` only — no localized message. Message rendering and code→HTTP-status mapping belong to edge/API changes.

Constants mechanism (same governance, lower stakes):

- Tuning constants (equip size budget, purge age threshold, competitive grace period, pool sizing) are declared with provenance inside their owning capability's file — a constant is part of the capability it tunes, not a standalone `constants.ts` junk drawer (standards 01 rejects cross-capability dumping); the competitive grace window (invariant rule 15, 90 days) lands with its consumer in task 4.2.
- Constants are values, not codes: changing a default is a reviewed config change, not a contract break; the registry makes every such value findable and testable.
- This change ships two registries in `packages/domain/src/errors/` (one file per module, the domain's error capability directory — never inside `schema/`, which holds only table structures): `errors/schema.ts` (construction and lifecycle rejections) now, and `errors/kernel.ts` (operation rejections) with task 4.2; later modules (workrun, delivery, api) add their own files under the same rules. The central module-registry enforces namespace uniqueness across the two.

### D9 — No DI framework; composition roots wire dependencies explicitly

Codegen-based dependency-injection tooling exists in ecosystems where constructor injection is unergonomic. TypeScript at this scale needs none: api/worker composition roots construct adapters and inject them explicitly (ADR-0001 already assigns composition to deployable boundaries). No service-locator, no decorator-based injection.

- _Alternatives_: introduce inversifyjs/nestjs DI — rejected: framework lock-in in composition roots, indirection without a consumer base.

### D11 — Schema registry: explicit per-file modules, no auto-registration

Every object schema lives in its own file with a uniform structure (imports → TSDoc header (single-statement = one line; multi-statement = a proper block) → enum schemas → object schema → inferred types), exported through the single `schema/index.ts` barrel. Each model file is self-contained: it imports only shared primitives (`ids`/`text`/`time`) and module registries (`errors`/`constants`), never another model's symbols — cross-model linkage is by uuid reference fields, not imports; sub-structures and behavior intrinsic to the type (Asset's content carrier and lifecycle table, WorkRun's intervention sessions) live in the owning model's file. Adding a type = add one file + one barrel line, with the barrel line serving as the review checkpoint.

- _Alternatives_: (a) a central manual-registration file restating the barrel — unnecessary indirection; (b) glob/`import.meta.glob` auto-registration — rejected: implicit magic, breaks deterministic module initialization (standards 01); (c) shared ref-schema aliases (`projectRefSchema` …) — rejected: structurally identical to `uuidSchema`, they only add a cross-file hop; ref semantics are carried by field names.

### D12 — No CRUD base model; shared primitives are the composition unit

Domain objects do not embed a GORM-`Base`-style common ancestor (id/created_at/updated_at/ext/deleted). The accepted baseline deliberately keeps change-time in the Event History envelope, not as mutable row state. Every registry object carries the governed quartet created_at/deleted_at/updated_at/updated_by (Equip/Checkpoint exempt — derived / timestamp-equal). The tombstone (deleted_at, instant never boolean) replaces any soft-delete flag; there is no untyped ext column (extension capability lives in schema-validated event payloads, Part D). Where structure is genuinely shared, it is composed from primitive schemas (the text/instant/uuid primitives) — schema-level composition instead of inheritance, per standards 01 code philosophy 3.

- _Alternatives_: (a) a `BaseSchema` mixin all objects extend — rejected: a common ancestor would smuggle updated_at/soft-delete onto every type and invite the exact drift this change guards against (created_at is adopted explicitly as part of the governed quartet, not via inheritance); (b) per-object timestamps "because every system has them" — rejected as a motive: created_at exists because the product owner directed the base-model field set with a governed mechanism, not by reflex.

T17b immutability attacks → kernel append tests; T9 optimistic concurrency → version-conflict tests; T13 lifecycle → transition table tests; T20 rationale → schema refinement tests; T21 delivery gate → kernel delivery tests; T23 permission → actor-gate tests; T24/T25/T26 scenario arcs → integration-style kernel tests (in-memory adapter). The research scripts remain the evidence trail; the vitest suites are the product's guard.

### D13 — Enterprise-hardening benchmarks behind the model (mechanism patterns only)

The schema layer was stress-tested against the publicly documented engineering practices of large-scale platform and enterprise-system vendors (cloud databases, hyperscaler API governance programs, network-equipment audit subsystems, and the largest Chinese consumer/internet engineering organizations). No vendor names or external links are recorded here by policy; the patterns themselves are the durable content:

- **Optimistic concurrency via a version attribute and conditional append** mirrors the documented pattern of the two most-deployed cloud NoSQL databases (version attribute + conditional write) and of distributed search engines (`if_seq_no`/`if_primary_term`). `current_state_version` is that pattern applied to an event-sourced aggregate.
- **Time-ordered identifiers without coordination** (UUIDv7 per RFC 9562) is the documented successor of coordinated sequence services (leaf-segment / tinyid style issuers and single-writer sequence servers): same ordering property, none of the coordination infrastructure. The 74-bit randomness covers cross-node uniqueness; per-millisecond counter and clock-step clamping cover local ordering.
- **Closed, documented, add-only error-code registries** mirror the payment-platform error-code model (stable string codes, one-line semantics, additions non-breaking, semantic changes flagged as breaking) and the error-type discipline of hyperscaler API guidelines (machine-readable `code`, no parsing of human text). This is D8's governance, already in force.
- **Immutable, attributable audit/event records** mirror network-OS audit subsystems (event records described as immutable, persistent objects created by state changes, never rewritten). This is the append-only Event History + INSERT-only trigger requirement.
- **Enum governance boundary** (closed enums only for internal state machines; machine identifiers across boundaries as governed registries; human vocabulary as free text) absorbs the industry lesson that adding an enum value observed by outside switch statements is a breaking change. Already codified in D8.
- **No boolean/`is_xxx` columns and no magic literals** where an explicit named state or named constant exists; every array bounded; strictObject rejecting unknown fields — these follow the mainstream Chinese industry coding standards' spirit (explicitness over implicitness) translated to a zod schema layer.

## Risks / Trade-offs

- [Frozen-event detection differs across transports (a Postgres round-trip loses freezing)] → Immutability is enforced at three layers: domain (Object.freeze + no mutator API), storage (Postgres trigger rejecting UPDATE/DELETE on event rows), and replay equality (tamper detection). Spec scenarios test each layer separately.
- [zod schema drift vs the accepted research baseline] → The baseline guard test pins field/enum sets; the domain spec's field-baseline table is the review contract with the maintainer.
- [postgres.js version churn] → pinned exact version like all repo deps; ADR-0005 records the choice and reconsideration criteria.
- [Replay cost growth with event volume] → This change accepts full replay (a 200-event replay-integrity experiment passed in the research repository); snapshotting is a later change — the port already carries saveSnapshot/loadSnapshot so the cost path is pre-wired.
- [Kernel API surface creep] → New semantics (WorkRun machine, Actions layer) come as later changes with their own specs; the kernel admits nothing beyond this change's spec.

## Migration Plan

New packages only; nothing existing changes. Rollback = revert the change commit; no data exists yet. Migrations run forward-only, idempotent (IF NOT EXISTS), tracked in a schema_migrations table with per-file sha256 checksums (editing an applied migration fails loudly; legacy checksum-less rows are adopted on first run).

## Open Questions

- Postgres trigger vs rule for event-row immutability — **closed: trigger**. Verified on a live PostgreSQL 15 instance: UPDATE/DELETE on the ledger raise inside the trigger and the append transaction rolls back atomically; rules are global rewrites and cannot enforce per-row INSERT-only semantics.
- Asset organization-scope ownership (the cross-project rule for rows without a project anchor) is not decided here — registered as research **OQ-49** (DEC-0009). This change carries the ruling's storage shape only: `project_id` is nullable with a CHECK that requires it for every non-organization scope, mirroring the schema-layer refine.
- Offline bidirectional merge: conflict detection via vector clocks/epochs, explicit conflict marking, and Candidate Merge review — never automatic merging. This change only guarantees single-writer append semantics; the offline-merge design lands as its own change with its own spec.
- Whether Equip budget is per-project config or global constant — **closed for R0: a global constant** (the grace constant lands with the kernel error registry in task 4.2); per-project config is a later change.
- Snapshot cadence policy (deferred to the snapshotting change).
