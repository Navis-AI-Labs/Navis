# Local instance runtime

## Why

An operator cannot yet give another project a working Navis connection: the API lacks durable project commands and provisioning, the client has no executable business composition, and Compose runs mutable checkout files without durable operational configuration. A deployable instance needs a complete command, client and recovery workflow.

## What changes

Deliver the non-UI local-instance workflow: operator-provisioned identities and device credentials, project creation and membership, capability-authorized durable kernel commands, complete cursor-bound reads, an installable CLI and persistent Bridge, contract-correct offline observation synchronization, and a reproducible Docker runtime with backup/restore and readiness verification.

## Scope and boundaries

Contracts owns public request/response and IPC schemas. Domain owns capability evaluation and business transitions. Application owns provisioning, project use cases and replay. Infrastructure owns transaction adapters and migrations. API owns authenticated transport and process composition. Bridge owns local credentials, binding, durable capture, remote transport and recovery; CLI delegates to Bridge.

The deployment target is one operator-controlled local machine, with HTTP exposed only on loopback and PostgreSQL running as a separate Compose service on a private network. Frontend, public Internet exposure, automatic external side-effect execution and high-availability deployment are outside this change. Existing effect facts and delivery gates remain accountable; reporting an effect never executes it.

Standards 01–12 apply. Existing packages and technology are reused; no placeholder workspace is admitted. The local operator provisioning command provides the non-browser administration path and must never be exposed as unauthenticated HTTP. Existing browser-flow requirements remain separate from operator provisioning.

The distribution consists of one Docker Compose project with separate API and PostgreSQL services. Compose owns startup ordering, networking, storage and container restart policies; each service owns its own process lifetime. Successful health probes produce debug logs, while failed probes retain visible failure logs. Instance-specific IDs, test runs and machine inventories are excluded from repository documentation.

An optional Agent skill uses the installed CLI for cross-project onboarding. Its local installation records the executable invocation outside the repository; it does not add an automatic runtime adapter or change human authority. Local submission accepts Windows code review and portable regression evidence while retaining native CI as a condition for a tested cross-platform release claim.
