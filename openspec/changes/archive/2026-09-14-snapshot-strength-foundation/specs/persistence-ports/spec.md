# persistence-ports Spec Delta

## MODIFIED Requirements

### Requirement: event store port is engine-neutral and defined in the domain layer

The ledger's guarantees must outlive any engine choice; the port is where engine freedom is kept. The system SHALL define an EventStore output port (TypeScript interface) in the domain layer, scoped per project aggregate, with operations: append (project id + events + expected version → optimistic concurrency), loadEvents (project id, from a sequence cursor), saveSnapshot, loadSnapshot, markRetention (project id + sequence range + retention class). The port MUST NOT reference any driver, SDK, or platform type. Implementations live in infrastructure and MUST NOT leak driver types across the port boundary. Every adapter satisfying the port SHALL persist snapshots losslessly and return them exactly as saved, SHALL treat loadSnapshot on a project with no stored snapshot as null — not an error, SHALL record retention marks idempotently (re-marking an already-marked sequence number in the same class is a no-op, not an error), and SHALL surface — instead of silently degrading — a stored snapshot that cannot be loaded losslessly.

#### Scenario: port has no driver types

- **WHEN** inspecting the EventStore port's TypeScript surface
- **THEN** no import of any database driver, SDK, or platform-specific type appears

#### Scenario: infrastructure implements the port

- **WHEN** the Postgres-wire adapter is instantiated with a connection factory
- **THEN** it satisfies the EventStore port interface (compile-time checked)

#### Scenario: snapshot round-trip is lossless or loud

- **WHEN** a snapshot is saved through any port-compliant adapter and then loaded
- **THEN** the loaded snapshot equals the one saved, and when no snapshot exists for the project the load returns null rather than raising an error

#### Scenario: retention marks are idempotent

- **WHEN** the same sequence number is marked twice in the same retention class for a project
- **THEN** the second write is a no-op that leaves one mark, and the operation succeeds without error

## ADDED Requirements

### Requirement: event identity is unique across the ledger

Each event identity SHALL name exactly one ledger event. An append batch containing a repeated identity, either within the batch or already recorded in any project, SHALL fail without appending any event or retention mark from that batch. All EventStore implementations SHALL enforce this contract. A command idempotency key does not replace event identity.

#### Scenario: duplicate event identities reject the whole batch

- **WHEN** two events in an append batch share an event identity even though their sequence numbers differ
- **THEN** the batch is refused and history and retention marks remain unchanged

#### Scenario: an existing identity cannot be reused in another batch or project

- **WHEN** a later append reuses an event identity already recorded in the same or another project
- **THEN** the append is refused without changing either project's history
