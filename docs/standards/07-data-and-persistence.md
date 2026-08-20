# Data and persistence standard

## Ownership and modeling

- Every authoritative record has one owning boundary. Caches, search indexes, vectors, analytics, and projections are explicitly derived.
- Transaction boundaries follow accepted invariants; they are not inferred from ORM relationships or controller structure.
- Storage models do not escape Infrastructure as public contracts. Domain and Application do not import ORM or client types.
- Database constraints enforce invariants that must survive concurrent writers. Application validation does not replace storage integrity.
- Time zone, precision, collation, ordering, identifier, nullability, and uniqueness semantics are explicit.

## Migrations

- Every schema change is an ordered, reviewable migration with forward-deploy and rollback or roll-forward instructions.
- Migrations remain compatible with the running and immediately adjacent application versions. Destructive changes use expand, migrate, verify, and contract stages.
- Backfills are resumable, bounded, observable, idempotent, and separated from latency-sensitive schema locks.
- Migration tests start from the oldest supported schema and verify data and application compatibility.
- Production releases never depend on manual unrecorded data edits.

## Lifecycle and recovery

- Retention, archival, legal hold, deletion, derived-data cleanup, and audit exceptions are defined before sensitive storage.
- Backups are encrypted, access-controlled, monitored, and restored in regular drills. A backup without a proven restore is not recovery evidence.
- Replicas, caches, and indexes document staleness and consistency. They do not answer authoritative queries when stale data is unsafe.
- Query plans and indexes are measured with representative volume. Unbounded scans and N+1 access block production paths.

## Verification

Adapter contract tests run against the selected engine. CI verifies migrations, constraints, rollback or roll-forward procedure, isolation, deletion propagation, and representative query plans.
