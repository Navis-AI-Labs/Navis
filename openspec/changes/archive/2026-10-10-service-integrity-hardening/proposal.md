# Service integrity hardening

## Why

The installed API can revoke another participant's device. Persisted observations can pass replay with malformed payloads, and the strict event producer silently strips undeclared nested privacy fields. Passing existing tests did not detect these failures.

## What changes

- Enforce the existing producer/consumer compatibility rule at nested privacy boundaries.
- Validate persisted observations during full replay, snapshot restoration and integrity verification without coupling Domain to transport schemas.
- Authorize device revocation against target ownership and return explicit authentication and authorization failures.
- Complete the pending API composition, immutable reads, CLI module ownership, database-fixture isolation and documentation corrections against their accepted requirements.

## Scope

Affected capabilities are `work-contracts`, `project-state-kernel` and `bridge-remote-sync`. Consumers are the API's project query and device-management routes, ingest replay, and local CLI invocation. No new workspace, database schema, runtime, dependency or public contract version is introduced. Domain owns replay; Contracts owns wire schemas; Application connects them and authorizes device management; API maps failures and constructs adapters.

This is a correction to the implemented foundation. Complete Bridge synchronization, CLI packaging, browser authorization, full project read models, effect delivery and production deployment remain outside this change. Existing Proposed ADRs retain their status.

## Review basis

The maintainer requested completion of the repository review, repairs needed for submission, and a commit on 2026-10-10. The scenarios below make the reproduced defects and acceptance criteria explicit. Applicable standards: `01-source-code` through `12-operations`; no UI is changed. Existing dependency and storage decisions suffice; no additional technology ADR is needed.
