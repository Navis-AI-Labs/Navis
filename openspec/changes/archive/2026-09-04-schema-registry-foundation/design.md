# Design: schema-registry-foundation

## D1. Registry shape: read-only module, minimal descriptors

The registry lives in `packages/domain/src/registry/` as a pure module with no command surface, no events, and no persistence. It registers exactly the eight core object types as minimal descriptors (name + kind) and exposes `lookup(name)` and `list()`. Closure is enforced by construction: the module exports the populated registry, not a mutator; the descriptor objects are frozen; the lookup table is built once at module initialization from a literal definition array (the kernel error token registry precedent — add-only, literal-keyed, no dynamic registration).

Why not kernel integration: the OQ boundary for the type registry states R0 covers only core types registered at startup; dynamic registration of accepted domain types is the R1 restore path through the schema-change acceptance flow. Building the command and event surface now would create consumers-less machinery — the observeClock precedent.

Why minimal descriptors (name + kind) rather than full zod schema references: the authoritative field shapes already exist in the domain schemas; duplicating them in the registry would create a second source of truth. The registry answers "which types exist and what are they called", not "what fields do they carry" — the schemas answer the latter. A reconciliation test pins the registry's name list to the schema module's exports so the two cannot drift.

## D2. Interfaces and link types: data structures with reference integrity

Interface and link type definitions are plain frozen data objects in `packages/domain/src/schema/` — not zod schemas of themselves initially; they are the vocabulary data that the eventual schema-change acceptance flow will carry. Each interface object carries: name, description, property declarations (name, type, required flag), and link type constraints (constraint name → link type name). Each link type object carries: name, from-type, to-type, cardinality, description, and an optional reverse name (`refines` declares `refined_by`).

Integrity rules, enforced by a `validateVocabulary()` function run in tests at module load: an interface constraint whose name matches a defined link type must agree on cardinality (a global relation and an interface constraint of the same name cannot disagree); an interface constraint with no matching link type stands as an interface-scoped requirement declaration and only its target interface must resolve; every endpoint a link type names resolves to a registered core type; template relations and implemented interfaces resolve to defined link types and interfaces. Failure names the unresolved reference. Property names align with the domain schemas: the `Assetable` lifecycle property uses the `lifecycle` name (aligned with the implemented Asset lifecycle enum and the v1.14.1 integration notes), and provenance is optional.

`refines` is included as a definition with a reverse name — the active plan lists it among the six core link type definitions. Its behavioral effect (quality-differential detection on concurrent writes) is not implemented anywhere in this change; the definition carries the semantics description only, exactly like `blocks_delivery` carries its description while the enforcement lives in the kernel delivery gate. Definitions are data; enforcement behavior is wherever the kernel already owns it.

## D3. Templates: data files, three sections, reference integrity only

Templates live in `packages/domain/src/schema/templates/` as frozen literal objects. Each template carries: name, description, and two sections — object type definitions (name, implements list, property declarations, and relations that consume the defined link types) and interface implementations (the interfaces its object types implement). Link type consumption lives only on the relations; a separate link-type list would duplicate the relations and invite drift. No action types section (the preset template scope covers object types, link types, and interfaces; action type templates belong with the criteria-action integration work). `generic_project` has empty domain sections — its value is naming the core-only starting point.

Integrity: every relation a template object type declares must reference a defined link type; every implemented interface must resolve. `validateVocabulary()` covers templates with the same failure discipline. Template object type definitions are intentionally structurally identical to what a future LLM-proposed domain type definition will look like (type definitions are data — the composition model); the template files double as the shape exemplar.

## D4. Criteria contract: types, literal-keyed registry, one baseline check

`ActionContext` (actor, action name, parameters, state version, equip state version) and `SubmissionResult` (passed, optional reason token) are plain types in `packages/domain/src/`. The criteria registry is a literal-keyed frozen record — same discipline as the kernel error token registry: keys are the criteria names, values are pure functions `(context) => SubmissionResult`, no dynamic registration path. `check_actor_permission` is the baseline entry: it wraps the kernel's existing actor authorization checks (participant registration plus participant-type gates in the command guards) behind the criteria signature. Authorization is policy applied to registration and participant type — never derived from the descriptive role field. A reconciliation test pins the criteria's verdict to the kernel guard's verdict on the same contexts.

Determinism is structural: criteria functions receive a frozen context snapshot and touch nothing but it — no clock reads, no state mutation, no I/O. The type signature enforces the read-only posture; the determinism test (same context twice → same verdict) pins it. Unknown criteria references fail explicitly with a named error, resolved through a `resolveCriteria(name)` lookup that mirrors the registry's lookup semantics.

## D5. Reconciliation tests as the drift guard

Three reconciliation surfaces, each a test that pins declaration to behavior: (1) registry ↔ schema modules — the registered name set equals the core type schemas' export names; (2) `blocks_delivery` declaration ↔ kernel delivery gate — the declaration's endpoints are Hold/Delivery and the gate refuses delivery with an active blocking hold (this requirement lives in the project-state-kernel delta because it constrains the kernel's observable gate); (3) `check_actor_permission` ↔ kernel command guards — verdicts agree on the same actor contexts. Drift in any direction fails the suite naming the mismatch.

## D6. Standards mapping and requirements traceability

Every task names its requirement, standards, and verification command. Applicable standards: 01 (source: frozen data objects, no dead code), 02 (testing: reconciliation suite, determinism pin, closure tests), 06 (contracts: data shapes are the vocabulary contract). No ADR: every mechanism decision here is a direct application of the accepted concept proposal (composition model, data-as-definition, literal-keyed registries) and existing repository precedent; no new material technology choice is introduced.

## Migration

None. No database changes, no event types, no command surface. The change adds modules and tests only; the migration guard in `schema_migrations` is untouched.
