# Proposal: r0-kernel-foundation

## Why

The foundation-baseline change is archived; the repository has tooling and business-neutral contracts but zero authorized business behavior. The implementation roadmap defined in the research repository (plan v1.6.0) cannot start without three things existing as accepted, testable behavior: the domain object model (8 core object types with their fields), the project-state kernel (immutable event history + versioned projection), and persistence ports that let the same domain code run against any PostgreSQL-compatible store. Every later task (Actions, Equip, WorkRun, UI) consumes these three, so they must exist first and be right.

Deployment reality: the team may deploy on Supabase, self-hosted PostgreSQL, or other Postgres-compatible engines. Platform lock-in at the kernel layer would make those moves architectural rewrites. This change therefore admits the storage abstraction as a first-class capability instead of an afterthought.

## What Changes

- Add `packages/domain` (new workspace unit, ADR-0001 compliant: imports no other Navis package):
  - Object schemas exactly per the accepted research baseline: 8 core object types + the Participant registry type (the system's only actor identity). No locally invented fields or enum values — a baseline guard test enforces this.
  - Project status is the baseline's four values (active/paused/completed/archived); Asset scope is the baseline's five values (participant/session/task/project/organization); Asset content is the baseline's physical-carrier object. Cross-project absorption/merge stays out of the single-project kernel (recorded as a research open question).
  - 8 core object type schemas (Project / Work / TaskSpace / Asset / Acceptance / Delivery / WorkRun / Hold) with zod runtime validation, including the rationale rule (`Acceptance.rationale` required on rejected/conditional, `result` enum accepted/rejected/conditional, symmetric reject/conditional actions data shape).
  - Asset lifecycle 7-state enum + legal-transition table (candidate/active/superseded/competitive_superseded/deprecated/archived/rejected; contested reserved, not enabled).
- Add `packages/infrastructure` (new workspace unit, implements application/domain output ports — but only the port types live in domain/application per ADR-0001):
  - `EventStore` output port definition (in domain), Postgres-wire-protocol adapter (in infrastructure).
- Project-state kernel in `packages/domain/state`:
  - Append-only Event History (frozen, structurally immutable), Current State versioned projection rebuilt by replay, optimistic concurrency via monotonic state_version.
- Persistence port: engine-neutral SQL over the PostgreSQL wire protocol. **Supabase is a deployment option, not a dependency**: no Supabase SDK, no Supabase-specific auth (RLS) as authorization layer, migrations as plain SQL. Any Postgres 15+ (Supabase, Neon, RDS, self-hosted, or local Postgres via Docker) works by supplying a connection string.

## Capabilities

### New Capabilities

- `domain-object-model`: The 8 core object types, their fields/types/requiredness, Asset lifecycle states and legal transitions, and conditional-rationale acceptance semantics as observable schema behavior.
- `project-state-kernel`: Immutable event history, event envelope, versioned current-state projection, replay/rebuild integrity, optimistic concurrency on state_version, append-only enforcement (mutation attempts rejected).
- `persistence-ports`: The storage port contract (append event, load events, save/load projection snapshot, transactional append), engine-neutrality rules (Postgres wire protocol only, no platform SDK in core), and connection configuration behavior.

### Modified Capabilities

(none — `foundation` spec stays untouched; this change adds capabilities)

## Impact

- New workspace units: `packages/domain`, `packages/infrastructure` (each with package manifest, tsconfig, admitted by this change — no empty placeholder dirs).
- `packages/contracts`: unchanged (transport primitives stay business-neutral).
- Dependency additions (to be ADR'd): `zod` in domain (already used by contracts); `postgres` (postgres.js driver — wire protocol, zero platform lock-in) in infrastructure.
- Requires new ADR-0005 (storage engine abstraction: Postgres-wire primary, SQLite tolerated for tests only) and records the Supabase-optional stance; zod-for-domain-validation rides existing contracts precedent, noted in design.
- Verification surface: `pnpm validate` gates (format/lint/typecheck/boundaries/test/build/openspec) all apply; dependency-cruiser rules must accept the two new units.
- Non-goals: no HTTP/API surface, no Actions use-case layer, no WorkRun state machine, no UI, no auth — later changes. (The kernel's read-side Equip derivation is in scope; a standalone Equip assembly service with its own lifecycle is not.) No Supabase-specific features (RLS, Edge Functions, Storage) anywhere in core.
