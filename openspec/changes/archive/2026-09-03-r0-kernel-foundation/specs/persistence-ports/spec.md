# persistence-ports Spec Delta

> **Capability intent** — The ledger's trust guarantees must outlive any single database vendor's choice. This layer defines storage as replaceable infrastructure: domain code faces the port, the Postgres wire protocol is the primary implementation, and the in-memory implementation backs the tests; whether the team runs Supabase tomorrow or self-hosts the day after, the same domain code changes by not a single line.
> **Scope boundary** — This capability defines only: the EventStore port contract, the Postgres wire-protocol adapter, the in-memory adapter, and the plain-SQL shape of migrations. Not included: ORMs and query builders (explicitly excluded), platform SDKs and platform authorization (explicitly excluded — RLS may serve as deployment-side defense in depth, but no behavior may depend on it), SQLite (not admitted; the in-memory adapter covers tests), and caches/queues/object storage (not defined by this capability).

## ADDED Requirements

### Requirement: event store port is engine-neutral and defined in the domain layer

The ledger's guarantees must outlive any engine choice; the port is where engine freedom is kept. The system SHALL define an EventStore output port (TypeScript interface) in the domain layer, scoped per project aggregate, with operations: append (project id + events + expected version → optimistic concurrency), loadEvents (project id, from a sequence cursor), saveSnapshot, loadSnapshot. The port MUST NOT reference any driver, SDK, or platform type. Implementations live in infrastructure and MUST NOT leak driver types across the port boundary.

#### Scenario: port has no driver types

- **WHEN** inspecting the EventStore port's TypeScript surface
- **THEN** no import of any database driver, SDK, or platform-specific type appears

#### Scenario: infrastructure implements the port

- **WHEN** the Postgres-wire adapter is instantiated with a connection factory
- **THEN** it satisfies the EventStore port interface (compile-time checked)

### Requirement: postgres-wire adapter works against any postgresql-compatible engine

The primary adapter SHALL speak the standard PostgreSQL wire protocol (postgres.js driver). It MUST NOT use any platform SDK (Supabase JS, Supabase Edge Functions), MUST NOT rely on platform-specific authorization (RLS policies) as the authorization layer, and MUST run migrations expressed as plain SQL files. Any PostgreSQL 15+ engine (Supabase, Neon, RDS, self-hosted, local Docker) SHALL be usable by supplying a connection string via environment configuration. The migration set covers the six-layer physical design: L1 the append-only event ledger; L2 append-only fact rows (acceptances, deliveries + delivery_attempts, effect_ledger); L3 synchronous projections (projects/works/assets/holds/work_runs/participants/checkpoints + project_snapshots, with updated_at/updated_by writable only by the replay path); L4 read models (event_outbox); L5 relation tables (work_dependencies, hold_source_events, hold_assets, workrun effect/evidence/candidate refs, intervention_sessions); and the command_inbox idempotency table plus event_retention_marks (retention classes as projection marks — ledger rows are never physically deleted). TaskSpace, Equip, and Candidate pipeline types have no physical table.

#### Scenario: connection via environment configuration

- **WHEN** the adapter is constructed with a DATABASE_URL connection string pointing at any Postgres 15+ engine
- **THEN** the adapter connects and schema migration applies cleanly on an empty database

#### Scenario: schema migration is plain SQL and idempotent

- **WHEN** migrations run twice against the same database
- **THEN** the second run is a no-op (idempotent) and the schema is unchanged

#### Scenario: event table enforces append-only at the storage layer

- **WHEN** a SQL UPDATE or DELETE is attempted against the event history table
- **THEN** the database rejects it (trigger/rule enforcing immutability at rest, defense in depth beyond the domain layer)

#### Scenario: optimistic concurrency enforced at the storage layer

- **WHEN** two appends race with the same expected version
- **THEN** exactly one succeeds and the other fails with a version-conflict error (unique/version constraint at the storage layer, not just application-level)

#### Scenario: delivery-gate query uses partial indexes

- **WHEN** the kernel evaluates check_no_blocking_hold before a delivery
- **THEN** the gate query unions active blocking holds with unclosed unknown effects (effect_ledger status='unknown') — both sides of the delivery-gate authority
- **AND** the underlying partial indexes (holds WHERE status='active' AND blocks_delivery; effect_ledger WHERE status='unknown') serve the query

#### Scenario: command idempotency is enforced at the storage layer

- **WHEN** a command with the same idempotency key is delivered twice within one project
- **THEN** the command_inbox unique constraint admits the first and the second delivery replays the recorded first result

### Requirement: in-memory adapter satisfies the same port for tests and local development

The system SHALL provide an in-memory EventStore implementation of the same port. Domain behavior tests SHALL run against the in-memory adapter without any database; the Postgres adapter SHALL be exercised by an integration test suite that is skipped automatically when no test database is configured.

#### Scenario: domain tests run without a database

- **WHEN** the kernel test suite runs on a machine with no database configured
- **THEN** all domain tests pass against the in-memory adapter

#### Scenario: integration tests skip cleanly without a database

- **WHEN** the integration suite runs without a configured test database URL
- **THEN** Postgres-dependent tests are skipped (not failed) and reported as skipped
