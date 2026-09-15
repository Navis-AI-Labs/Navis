# Proposal: work-contracts

## Why

Navis's continuity promise — an agent can be re-equipped and return work across sessions, runtimes, and vendors — currently has no public shape: the Equip payload and Return submission live only inside the domain kernel, and the Contracts package carries zero business payloads by design. They must become versioned public contracts; without them, the future API, the Bridge outbox, and every Adapter would each invent divergent shapes. This change delivers the first business contract surface: the Canonical Work Event schema and the Equip/Return contracts.

## What Changes

- **New capability `work-contracts`**: the Contracts package gains its first business payloads, as runtime-validated schemas with TypeScript types inferred from them:
  - Canonical Work Event envelope — schema-versioned, event-typed, carrying the extraction metadata proven necessary by research (source runtime, session, project mapping, raw reference, extractor version, confidence, review status).
  - Equip contract — the public shape of the issued work contract (facts, assets, holds, boundary, criteria, causal snapshot, allowed actions as descriptive-only).
  - Return submission contract — request and result shapes for returning work against an equip, with rejection expressed through the existing Problem Details / version-conflict profile.
- **Modified capability `foundation`**: the transport-profile requirement is reworded — profile primitives stay business-free, while business payloads now live in the `work-contracts` capability instead of being excluded outright.
- No server code, no API routes, no transport wiring; contracts remain consumable without server internals, per ADR-0001.

## Capabilities

- **New Capabilities**: `work-contracts`
- **Modified Capabilities**: `foundation` (one requirement reworded)

## Impact

- Code: `packages/contracts` only (new schemas, types, fixtures, tests). Domain and application changes are out of scope unless the design review of the Return result shape (conflict visibility) elects the optional kernel read-back field; that decision and its blast radius are adjudicated in `design.md`.
- Public surface: `@navis/contracts` stays private and unpublished; schemas are versioned from `schema_version` 1 with additive-only evolution rules (standard 06).
- Dependencies: none added (zod already present). No new ADR is expected — precedent boundary decisions live in ADR-0001 and standard 06; if review surfaces a technology choice, this section is revisited.
- Standards read for this change: `00-index`, `01-source-code`, `02-testing`, `04-security` (rejection surfaces must not leak internals), `05-documentation`, `06-contracts-and-compatibility` (primary), `09-dependencies-and-supply-chain`.

## Non-goals

- Return is not promoted to a Schema-layer Action Type (deferred to R1 review per the R0 landing plan).
- No SDK/Bridge/Protocol repositories, no JSON Schema export, no retrieval/query read surface, no domain behavior changes beyond the single adjudicated exception above.
