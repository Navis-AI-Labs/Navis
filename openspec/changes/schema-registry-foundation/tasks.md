# Tasks: schema-registry-foundation

## 1. Registry (pure domain)

- [x] 1.1 Create `packages/domain/src/registry/`: core type descriptor type (name + kind), literal definition array of the eight core object types, frozen lookup table built at module init, `lookup(name)` (explicit not-registered failure) and `list()` (stable order). Requirements: registry-answers + closure; design D1. Standards: 01, 06. Verify: `pnpm exec vitest run packages/domain/test/registry.test.ts`
- [x] 1.2 Registry tests: eight names listed with kinds; lookup by name returns descriptor; unknown name fails explicitly naming the request; repeated listings identical; descriptors frozen and no mutation path from query results. Requirements: registry-answers + closure. Verify: same command, coverage 100% on new module

## 2. Interfaces and link types (data + validation)

- [x] 2.1 Create interface definitions (`Assetable` with identity/scope/provenance/lifecycle/content/created-at property declarations and derived_from/refines constraints; `Deliverable` with acceptance-linked properties and its acceptance-record constraint) and six link type definitions (depends_on, implemented_by, contains_clause, blocks_delivery, derived_from, refines with reverse name) as frozen data objects in `packages/domain/src/schema/`. Requirements: interfaces-as-data + link-types-as-data; design D2. Standards: 06. Verify: `pnpm exec vitest run packages/domain/test/vocabulary.test.ts`
- [x] 2.2 `validateVocabulary()`: interface constraints resolve to defined link types; link type endpoints resolve to registered core types; failures name the unresolved reference; run at module load in tests. Requirements: interface constraint resolution + endpoint resolution; design D2/D5. Standards: 02. Verify: same command — negative cases for each integrity rule
- [x] 2.3 Vocabulary tests: Assetable shape assertions; blocks_delivery endpoint assertions; refines reverse name; implementing-types-own-their-properties semantics documented by structure. Requirements: interfaces-as-data + link-types-as-data. Verify: same command

## 3. Templates (data + integrity)

- [x] 3.1 Create `packages/domain/src/schema/templates/`: `software_project` (domain object types with implements/properties/relations, link type references, interface implementations) and `generic_project` (core-only, empty domain sections) as frozen data; extend `validateVocabulary()` to cover template relation and interface references. Requirements: templates-as-data; design D3. Standards: 06. Verify: `pnpm exec vitest run packages/domain/test/templates.test.ts`
- [x] 3.2 Template tests: software_project references all resolve; generic_project defines no domain types; templates carry no action types, criteria references, or commands. Requirements: templates-as-data. Verify: same command

## 4. Criteria contract (types + baseline check)

- [x] 4.1 Create `ActionContext`/`SubmissionResult` types and the literal-keyed frozen criteria registry with `check_actor_permission` wrapping the kernel's actor authorization guards (registration + participant-type gates); `resolveCriteria(name)` with explicit unknown-reference failure. Requirements: criteria-contract; design D4. Standards: 01, 06. Verify: `pnpm exec vitest run packages/domain/test/criteria.test.ts`
- [x] 4.2 Criteria tests: unauthorized actor fails with named reason; authorized actor passes; same context twice yields identical verdicts; unknown reference fails explicitly; context objects are frozen and criteria functions cannot mutate them. Requirements: criteria-contract; design D4/D5. Verify: same command

## 5. Reconciliation and guards

- [x] 5.1 Registry ↔ schema reconciliation test: registered name set equals the core type schema exports. Requirement: closure; design D5. Standards: 02. Verify: `pnpm exec vitest run packages/domain/test`
- [x] 5.2 blocks_delivery ↔ delivery gate reconciliation test (kernel delta requirement): declaration endpoints are Hold/Delivery and the gate refuses delivery while an active blocking hold chains the asset. Requirement: declaration-gate pinning; design D5. Standards: 02. Verify: `pnpm exec vitest run packages/domain/test` — kernel gate scenario included
- [x] 5.3 criteria ↔ kernel guard reconciliation test: `check_actor_permission` verdict matches the kernel command guard on the same actor contexts. Requirement: criteria-contract; design D5. Standards: 02. Verify: same command
- [x] 5.4 Asset.content baseline pin: field list (media_type/storage/ref/size/sha256, inline-refines exclusivity) asserted against the domain schema. Requirement: no new capability — baseline guard; design D1 rationale. Standards: 02. Verify: same command
- [x] 5.5 Full gate: `pnpm validate` (format, build, lint, typecheck, boundaries, coverage thresholds, openspec strict) green; live-DB suite rerun with zero unexpected skips. Requirement: all. Standards: 00, 02. Verify: `pnpm validate`; `DATABASE_URL="postgres://postgres@127.0.0.1:5432/navis_test" pnpm exec vitest run`
