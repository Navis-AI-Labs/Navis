# Design

## Identity and authority

Instance principals provide the verified human/agent kind; clients cannot choose actor kind in project commands. Local operator provisioning is privileged by access to the service container and issues a device secret once. Only its verifier is stored. Each project membership stores separate proposal/execution grants. The server evaluates persisted grants on every command and supplies capability descriptions with Equip; client-supplied allowed_actions cannot confer permission. Human-only kernel transitions remain human-only even when an agent has an execution grant.

## Durable project operations

Project creation, owner membership, events, directory projection and idempotency outcome commit atomically. Command execution runs under a project-scoped database lock with the same transaction-bound ports. Identity, command type and payload are part of the fingerprint; retries cannot replay another actor's result. Failed commands preserve intentional kernel rejection events; exceptions roll back every write. Reads return a complete projection with ledger_seq distinct from business state_version, so ordinary activity can refresh context. Bounded history/replay limits fail explicitly rather than silently truncate state.

## Local client

CLI and daemon ship together. The CLI starts/reuses an independent per-user daemon; IPC is bounded and local, with private directories/socket permissions. Durable data lives in SQLite and credentials in the OS keychain or an explicitly configured private credential file for unattended local operation. Binding requires server membership verification and stores no secret in navis.toml. Metadata is the default; local policy can only reduce the server policy. Extracted observations use Contracts directly, with UUIDv7 identities and provenance. Outbox sequences remain monotone after acknowledgment; pending records are grouped by project and device. Only a complete, validated, batch-index-correlated receipt can remove a captured record. Interrupted sending becomes pending on restart. Retries have durable deadlines and bounded backoff; authentication/authorization errors stop automatic retry until operator action.

## Runtime and operations

Build an immutable API image from the frozen workspace graph and use a separately pinned PostgreSQL image. One Compose project owns both services, with API startup depending on database health. PostgreSQL owns a persistent data volume and has no published host port. API bootstrap copies mounted secrets to private volatile storage, then permanently drops to its service account before starting the existing API entry. No custom database supervisor runs in the API. Container exit is handled by each service's restart policy; a dependency outage changes API readiness while the API remains alive and reconnects when PostgreSQL recovers. Startup without a valid database fails closed. Database backups precede deployment replacement and restore checks use disposable resources.

The Docker API probe runs every 30 seconds with a 5-second process timeout, a 60-second startup grace period and three failures before unhealthy status. Successful health/readiness requests use debug logging; failed probes retain warning/error logging and correlation. Docker health state alone does not restart a still-running container. Orchestrator readiness intervals and alerting must follow their own availability objectives.

## Threats and limits

Untrusted clients can forge actor/resource identifiers, replay command keys, duplicate events, send corrupt receipts, or attempt human actions with agent keys. Negative tests must prove no unauthorized ledger/device mutation and no unacknowledged local data loss. Plaintext HTTP is confined to this local operator boundary; remote/LAN exposure requires TLS and another deployment review. No production-ready claim follows solely from coverage. Remaining unverified controls are recorded explicitly.

## Verification

Selected standards: 01-source-code, 02-testing, 03-errors-and-observability, 04-security, 05-documentation, 06-contracts-and-compatibility, 07-data-and-persistence, 08-concurrency-and-reliability, 09-dependencies-and-supply-chain, 10-performance-and-resources, 11-ci-and-release, 12-operations.

Use pure command/capability tests, real PostgreSQL transactions, real SQLite restart tests, installed CLI child processes and actual HTTP routes. Exercise create/work/equip/return/accept/deliver, actor isolation, replay identity, concurrent writes, offline capture, lost response, process death, revoked credentials, service restart, readiness during database outage, and backup restoration. Run pnpm validate with zero database skips and dependency audit. Keep committed documentation focused on reproducible procedures and supported behavior; instance inventories and individual test-run output are not repository documentation. Leave the verified operator environment running with private credentials and reproducible connection instructions.

## Unreleased baseline and model service

The unreleased schema is maintained as a single initial baseline. Consolidate SQL into the initial schema; preserve the pre-change local database backup rather than adding compatibility migrations for this unreleased database. The initialization runner remains for fresh databases and checksum detection.

Model-provider URL, model name and secret are separate from Navis device authentication and Bridge's remote instance URL. The configured provider is invoked only by an explicit project assistance operation with bounded input/output, timeout and concurrency. Model output becomes candidate material and never performs acceptance or external effects. Provider credentials are server-side Docker secrets and never enter project declarations, responses or telemetry. A small synthetic live-provider request verifies connectivity; model-dependent tests use controlled HTTP servers for deterministic failure coverage.

The server adapter targets PostgreSQL 15+ SQL and protocol semantics. SQLite belongs exclusively to the Bridge. Supporting another database engine requires a separate adapter and real-engine contract validation. A different database used by a consuming project does not affect its access to Navis over HTTP.

## Host portability and contributor tooling

Keep the server distribution as a Linux container on Docker Engine or Docker Desktop. Native CLI/Bridge code supports Windows, macOS and Linux. Generate a PowerShell launcher and CMD entry on Windows, and a shell launcher on POSIX hosts; all delegate to a common generated Node entry that selects the default profile only when the caller has not supplied one. Invoke pnpm through its JavaScript executable to avoid Windows command-shell quoting. Windows private-directory and credential checks use native ACLs; the reusable policy script belongs to Bridge security and is also used by repository setup. Pipe names are derived from the normalized profile path, not a username alone. Unix sockets use a bounded runtime path when a profile path is too long.

Type-aware lint uses the tooling TypeScript project with explicit source mappings for public workspace package entries. Production package exports still point to built artifacts. Verify source lint with generated declarations hidden as well as normal build and packaged-client tests. CI exercises native client startup, profile isolation and setup on each supported host; container deployment checks remain in the Linux lane.

API image packaging and client installation share a package deployment module that materializes independent files and rejects external symbolic links. Package self-references resolve inside the deployed artifact, including after copying the API into its runtime image. Workspace/store hard links must not let later builds partially mutate an already installed runtime.

Windows PowerShell launchers use a UTF-8 BOM for PowerShell 5.1 and later. The ASCII CMD shim delegates to that launcher so an installed Node path containing non-ASCII characters does not depend on the command shell's code page. CLI JSON files accept UTF-8 with or without a BOM; UTF-16 input remains unsupported.

Local-instance submission accepts review of Windows launch, filesystem, ACL, IPC and process semantics with portable regression tests. This acceptance does not claim an observed native Windows run. The native three-host CI matrix remains required before advertising a tested cross-platform release.

## Agent onboarding

A distributable skill under `integrations/skills/navis/` teaches an external Agent how to use the installed CLI. It owns instructions only, has no runtime authority, and does not install automatic hooks or an MCP service. The instance installer copies it to an explicitly selected skill directory and records the local executable invocation only in that installed copy. It never commits host paths or credentials. Operator provisioning and human decisions remain explicit; the Agent uses its own profile. Existing development documentation owns setup and installation instructions.

## Container names and operational log retention

Use Compose's generated project/service/replica names and stable service DNS. Do not set container_name merely to remove the replica suffix. Application logs are structured stdout; PostgreSQL logs to stderr; Docker's local driver rotates and compresses both streams with an explicit size/file-count cap, following Docker's recommendation for non-Kubernetes deployments. Successful probes remain debug-level. The API process entry emits safe startup/shutdown outcomes. PostgreSQL excludes statement/parameter logging and uses terse errors to omit row DETAIL/CONTEXT, while keeping failure summaries. API logs, PostgreSQL logs and business audit are different data products; log rotation never deletes authority records. Long-term searchable log retention and alerting require an operator-owned collection service before a broader production release.
