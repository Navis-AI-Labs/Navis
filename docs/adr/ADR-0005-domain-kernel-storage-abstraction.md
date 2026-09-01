# ADR-0005: Domain kernel storage abstraction

- Status: Proposed
- Date: 2026-08-29

## Context

The kernel change (`r0-kernel-foundation`) needs to persist an append-only event history and versioned projections without coupling the domain to any specific database vendor. Supabase is one deployment option the team is evaluating, but the team may equally deploy plain PostgreSQL. The domain must not depend on Supabase SDK types, RLS policies, or any vendor-specific client.

At the same time, this codebase's law (AGENTS.md, openspec/project.md) requires that only code admitted by an active OpenSpec change may exist, and dependencies require explicit admission with rationale.

## Proposed decision

1. The domain defines an engine-neutral `EventStore` output port (TypeScript interface, in `packages/domain/src/ports`): `append`, `loadEvents`, `saveSnapshot`, `loadSnapshot`, all scoped per project aggregate. The port carries no driver types — only domain types (event records, version numbers).
2. The infrastructure package implements the port twice: an in-memory adapter for tests, and a PostgreSQL adapter using `postgres` (postgres.js) with plain SQL migrations and a `DATABASE_URL` connection factory. The domain never imports either adapter; composition roots wire them.
3. PostgreSQL remains the storage engine either way. Supabase is a deployment option (managed PostgreSQL plus its PostgREST surface), not an architecture dependency: connecting to it is just a `DATABASE_URL` value. If the team later chooses Supabase-specific features (RLS, edge functions), that choice arrives as its own change and must not break the port abstraction.
4. Dependency admission: `postgres` (postgres.js) enters `packages/infrastructure` only, pinned exact version (`postgres@3.4.7`; consumers: `postgres-event-store.ts`, connection factory; chosen over `pg` for its protocol-level SQL parameterization and tag-template API, over an ORM per Alternatives below). `zod` is already admitted in contracts; the domain reuses it for runtime validation (no new dependency, `zod@4.4.3`).
5. Migrations are plain SQL files under `packages/infrastructure/migrations/`, applied by a versioned, idempotent runner in the infrastructure package. No ORM, no migration framework dependency.

## Consequences

- The domain stays testable with zero infrastructure: unit tests run against the in-memory adapter.
- Swapping or adding engines (Supabase-managed PostgreSQL, self-hosted, or a future embedded engine) is a configuration change, not a rewrite.
- The team must keep SQL migrations hand-written and reviewed; automation here is deliberately rejected.
- Postgres-specific guarantees (INSERT-only trigger, unique constraint for optimistic concurrency) are the persistence layer's concern and are tested by integration tests that auto-skip when no `DATABASE_URL` is present.

## Alternatives

- **Adopt the Supabase SDK in the domain:** rejected — vendor lock-in of the trust engine; violates ADR-0001 (domain imports nothing).
- **ORM (Prisma/Drizzle) over the port:** rejected — a second schema language and codegen cycle for a storage need that plain SQL serves; the T-series simulations validated raw event rows, not ORM models.
- **EventStoreDB / specialized event stores:** rejected — operationally heavier than PostgreSQL for R0, and the ledger semantics (append-only, replayable) are simple enough for SQL.
- **In-memory only for R0:** rejected — persistence is a first-class requirement of the kernel change (R0-05 in the research plan); deferring it would make the ledger a toy.

## References

- OpenSpec change `r0-kernel-foundation` (persistence-ports spec)
- ADR-0001 (dependency direction: infrastructure implements ports)
