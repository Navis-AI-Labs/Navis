# Proposal: snapshot-strength-foundation

## Why

Long-lived projects need usable snapshots and evidence-based retention suggestions. The existing storage exposes snapshots, but the kernel never consumes them and no capture flow exists. Asset lifecycle rules exist without a read path that can suggest retirement.

Verification also exposed defects in the foundations these capabilities consume: writable public authority, candidate activation without Acceptance, incomplete Equip/Checkpoint outputs, session-identity collisions, and permission-criteria drift.

## What Changes

- Add event-count/logical-time capture policy as human-governed project state.
- Capture one consistent observation through EventStore, with explicit retention marking and interruption recovery.
- Identify snapshots by event cursor and consume them during replay with validated structure and metadata.
- Classify permanent events on append and prove identical adapter behavior.
- Compute read-only strength and legal retirement suggestions while keeping missing observations neutral.
- Close the identified authority and participation defects and replace ineffective tests with real contract and failure evidence.

## Capabilities

New: `snapshot-strategy`, `asset-strength`.

Modified: `project-state-kernel`, `persistence-ports`. Existing WorkRun, Equip, Acceptance, and registry behavior is preserved while the implementation is brought into conformance with its governing contracts.

## Impact

- Domain gains shared runtime projection validation, snapshot evaluation, and strength.
- Application is activated for capture orchestration, importing Domain in source and Infrastructure only for tests.
- Infrastructure gains cursor-based snapshot storage and atomic retention classification in the undeployed baseline migration.
- Dependency rules, compiler references, ADR-0008, and current architecture/status documentation are synchronized.
- No third-party dependency, service runtime, HTTP endpoint, UI, dynamic schema pipeline, or effect executor is introduced.

## Verification

Complete Domain invariants, shared in-memory/PostgreSQL conformance, shared capture recovery tests, real-database migration validation, dependency-negative checks, and the full repository gate are required. Passing coverage alone does not establish business correctness; strength calibration remains experimental.
