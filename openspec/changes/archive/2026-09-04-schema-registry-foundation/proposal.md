# Proposal: schema-registry-foundation

## Why

The kernel executes project facts through a fixed universal vocabulary (assets, holds, deliveries, work runs), but the vocabulary itself has no authoritative home: nothing answers "which object types exist, how do they relate, and what does a project start with" without reading source code. Before the minimal UI can offer schema candidates for human acceptance, and before any LLM can propose type definitions as data, the repository needs the foundational layer that defines interfaces, link types, preset templates, a read-only type registry, and the deterministic criteria contract — all as serializable data, per the composition-over-inheritance model.

## What Changes

- Add two core interface definitions (`Assetable`, `Deliverable`) as data, with shared property shapes and link type constraints
- Add six link type definitions (depends_on, implemented_by, contains_clause, blocks_delivery, derived_from, refines) as shape data with direction, cardinality, and semantic description
- Add a read-only type registry that registers the eight core object types at startup (minimal descriptors: name, kind, lifecycle) and exposes lookup/list queries with an add-only closure guarantee
- Add two preset templates (`software_project`, `generic_project`) as data files covering object types, link types, and interfaces only
- Add the submission criteria contract: `ActionContext` and `SubmissionResult` types plus a baseline `check_actor_permission` implementation in a literal-keyed criteria registry, reconciled with the kernel's existing actor-role checks
- Add reconciliation tests that pin link type declarations to live kernel behavior (the active blocking hold check in the delivery gate) and pin the registry's core type list to the existing domain schemas
- No kernel commands, no new event types, no database changes: the schema layer's event surface (schema change acceptance) is deferred to the R1 restore path and is explicitly out of scope here

## Capabilities

### New Capabilities

- `schema-registry`: observable behavior of the type registry, interface and link type definitions, preset templates, and the submission criteria contract — what a consumer can query, what shapes exist, what the templates contain, and what the criteria contract guarantees

### Modified Capabilities

- `project-state-kernel`: add a requirement pinning that the kernel's blocking-hold delivery check is declared by the `blocks_delivery` link type (declaration-behavior reconciliation, no behavior change)

## Impact

- **Code**: new modules under `packages/domain/src/registry/` (registry) and `packages/domain/src/schema/` (interfaces, link types, templates); tests under `packages/domain/test/`. No changes to `packages/domain/src/state/` kernel logic, no migration files, no new error tokens expected
- **APIs**: none — internal domain layer only; no transport or application surface changes
- **Dependencies**: none added; standard-library and existing zod patterns only
- **Standards**: `docs/standards/01-source-code.md`, `02-testing.md`, `06-contracts-and-compatibility.md` (data contract shapes), `00-index.md`
- **ADR**: none required — mechanism selection (data-as-definition, literal-keyed registry, read-only R0 scope) follows the accepted concept proposal; no new material technology choice beyond it
- **Future consumers**: minimal UI schema candidate flow (R1 restore path) and LLM generation pipeline both consume the shapes introduced here
