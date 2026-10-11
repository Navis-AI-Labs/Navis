# ADR-0013: Headless local instance runtime

- Status: Accepted for the local instance scope
- Date: 2026-10-11

## Context

The headless instance needs one Compose project with separate API and PostgreSQL services that other projects can access through a stable API and installed client. Its unreleased schema can be maintained as an initial baseline. This decision records the implementation choices for `local-instance-runtime`.

## Decision

- Keep the existing Node HTTP service, PostgreSQL port adapters and SQLite Bridge. Build a pinned API image and run PostgreSQL in its own pinned container. Compose owns network, data volume, service health and restart policies. API startup waits for PostgreSQL health. API bootstrap copies private secrets and permanently drops to its unprivileged account; PostgreSQL uses its image's own process entry. The API does not manage the database process.
- Use a 30-second Docker API probe with a short request deadline, three failures before unhealthy status and a startup grace period. Successful probes use debug logging; failures remain visible. A dependency failure changes readiness without terminating a healthy API process. Docker health status is an observation, not an automatic restart trigger.
- Keep Compose-generated project/service/replica names; service names are the stable operational interface. Use Docker's recommended `local` log driver for this non-Kubernetes profile, with bounded rotation and compression. API logs remain JSON stdout, PostgreSQL logs stderr; no second log store is written into application directories. Database statement/parameter and failing-row detail logging is disabled by default while error summaries remain available. Business audit remains database authority, independent of operational retention.
- Keep device identity and project policy separate. Local operator provisioning creates a verified human or agent identity. Project membership stores proposal and execution grants; Domain evaluates them and retains human-only gates. Device-flow code/session consumption uses row-locked transactions.
- Commit project commands, their idempotency outcomes, directory updates and initial membership together. A project-scoped PostgreSQL lock also protects configured ledger capacity checks. Reads refuse an over-budget ledger rather than truncate it.
- Use SQLite WAL with `synchronous=FULL`. Captures, retry identities and causal heads commit together; acknowledgment never resets the sequence allocator. Initialization DDL and its checksum record share one transaction. CLI and daemon are installed together, with bounded local IPC and explicit private-file credentials for unattended use.
- Support automatic capture at metadata or local-only level. Project policy is human-governed; a personal choice can only reduce it. Raw evidence/encrypted transcript transfer is not advertised by this profile. Explicit project artifacts and model-assistance prompts use their own authenticated operations.
- Run model generation as a supervised, durable job within the API process. Store the generation before applying its idempotent candidate command. Use one active generation, finite attempts, response/input limits and operator-configured queue/daily budgets. A model receives no tool executor and cannot accept its output.
- Keep model credentials server-side. Encrypt backups with AES-256-GCM and a separate local backup key. Verify authentication before restoring into an isolated database. Publish HTTP on host loopback and keep PostgreSQL on the Compose network without a published host port.

## Alternatives and consequences

Separate API and database services make their status, storage and lifecycle independently visible in the same Compose project. The single-container alternative requires custom multi-process supervision and couples API replacement to database restart; that packaging is not retained. A separate worker deployment adds operational coordination before it has a distinct local consumer; the persisted job port permits that later split. Mutable checkout mounts obscure which code is running and are replaced by the build artifact. Automatic browser approval or implicit human identity would bypass the trust boundary; the headless profile uses explicit operator provisioning and distinct human/agent credentials.

This is a single-machine deployment decision. Public Internet exposure, high availability and raw encrypted transcript transport require their own admission and operating evidence. The existing ADRs retain their recorded statuses; this decision does not silently rewrite historical review outcomes.

## Native host integration

The container is a Linux artifact usable through Docker Engine or Docker Desktop. Native clients and setup target Windows, macOS and Linux. Generate platform-specific launchers around a common Node entry; invoke the package-manager JavaScript entry without a Windows command shell. Use native ACLs on Windows and private Unix permissions elsewhere. Windows IPC identity includes the profile directory so human and agent profiles cannot reuse each other's daemon. Keep host-derived paths and generated credentials in ignored installation state.

Type-aware source lint uses explicit public-entry source mappings in the existing tooling project. This avoids error-typed imports from missing or stale generated declarations while leaving runtime packaging and strict unsafe-value rules intact.
