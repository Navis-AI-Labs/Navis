# Architecture baseline

## Status

This document defines implemented modules and planned process boundaries. Remaining integration and release gates are recorded in [foundation readiness](foundation-readiness.md).

There are seven source-bearing workspace units. The API and local integration packages exist. Web and a separately deployed Worker remain planned; the implemented model assistance worker runs within the API process. The ten historical ADRs retain their recorded `Proposed` status. ADR-0013 records the accepted local runtime decision; it does not change historical statuses.

| Boundary       | Current implementation                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain         | Object schemas, single-project kernel, event history and replay, acceptance/delivery/hold gates, WorkRun/intervention, causal clocks, snapshot policy, strength advice, closed vocabulary |
| Contracts      | Runtime schemas for transport primitives, Canonical Work Events, public Equip and Return, ingest, project query, device authorization and session hook                                    |
| Application    | Snapshot capture, authorized project commands/membership, atomic workspace operations, candidate model jobs, ingest, queries, device authentication/provisioning                          |
| Infrastructure | In-memory and PostgreSQL adapters, transaction-bound workspace and device auth, bounded event store, leased model jobs and provider transport                                             |
| API            | HTTP listener, authenticated route composition, adapter construction and resource cleanup                                                                                                 |
| Bridge daemon  | Installed process, private credentials, IPC, verified bindings, SQLite Outbox, canonical metadata capture, validated receipts, recovery and cursor-aware context                          |
| CLI            | Installed executable delegates project, review, capture, sync and model operations to Bridge                                                                                              |
| Web / Worker   | No source workspace; user workflow and runtime admission remain outstanding                                                                                                               |

## System ownership

The intended product separates local execution from shared project authority:

```text
Human -> CLI / planned Web -> API command/query boundary
                                 |
                            Application
                                 |
                              Domain
                                 |
                     output ports / Infrastructure
                                 |
                            PostgreSQL

Agent runtime -> hook / CLI -> Bridge daemon -> public API contracts
                               |
                        local SQLite + keychain
```

CLI, Bridge and API paths run in the local profile. Web remains planned. The service owns project state, accountable review and business audit. The Bridge owns device-local access, consent, credentials and offline transfer. The external Agent runtime owns its execution session. A synchronization acknowledgment records transport success; it does not accept a candidate or confirm delivery.

| Boundary       | Owns                                                                           | Must not own                                                |
| -------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Web            | Human workflows and presentation of server state                               | Direct database access or authority mutation                |
| API            | Transport mapping, authentication integration and process composition          | Business policy inside HTTP handlers                        |
| Worker         | Retryable asynchronous use-case entry points                                   | Unreviewed acceptance or direct state mutation              |
| Domain         | Framework-independent business policy, event application and valid transitions | HTTP, SQL drivers, filesystem access or runtime integration |
| Contracts      | Independently consumable public wire schemas and inferred types                | Server-private rows or classes                              |
| Application    | Use-case orchestration and use of output ports                                 | Concrete transport and persistence adapters                 |
| Infrastructure | Implementations of Domain and Application ports                                | New business policy                                         |
| Bridge         | Local state and public-contract integration                                    | A second project authority                                  |
| CLI            | User and hook invocation                                                       | A second binding store or independent remote transport      |

## Dependency direction

`A -> B` means A may import B under the architecture baseline:

```text
web -> contracts
api / worker composition -> contracts, application, infrastructure
infrastructure -> application, domain, contracts
application -> domain, contracts
domain -> no other Navis package
contracts -> no server implementation package
```

Domain currently owns the EventStore, CommandInbox, DeviceAuth and ProjectDirectory ports. Infrastructure implements them; its transaction-bound intake also imports Application dispatch. This is an actual dependency, not a future placeholder.

The intended local integration boundary consumes public contracts. The current Bridge package also imports Domain's lifecycle interface, ID generation and canonical hashing; CLI imports Bridge and Contracts. Their eventual distribution boundary and the lifecycle contract's ownership need explicit review before package publication.

Only `services/api/src/platform/composition.ts` may import Infrastructure inside the API source tree. It constructs the concrete adapters; other API modules consume public contracts, use cases and ports. The composition module is itself restricted to the four admitted server packages. TypeScript references follow the same build dependencies.

## Package and module depth

A workspace package is a compilation, dependency, deployment, publication, trust or ownership boundary. Internal capabilities do not receive their own package manifests or compiler configuration.

A new workspace unit requires a concrete consumer or independent runtime, release or ownership responsibility. Source grows by capability and then use case. Generic `utils`, `helpers`, `shared` and placeholder source directories do not establish ownership.

### Service entry and module ownership

- `platform/index.ts` is a process entry: load configuration, start the runtime and handle signals.
- `platform/composition.ts` constructs adapters, runs migrations and releases the pool after HTTP shutdown or failed startup. Its signatures expose runtime behavior and ports, not concrete adapter unions.
- `platform/routes.ts` installs the route factories and request-local identity scope. Ingest membership is checked against the event projects; the claimed device must match the authenticated caller.
- `platform/config.ts` owns this service's environment mapping, defaults and startup validation. `runtime-config.ts` resolves secret files and requires PostgreSQL for executable startup; injected test composition can use memory.
- `packages/cli/src/index.ts` is a package export entry. Invocation parsing and dispatch live in `commands/invocation.ts`; `process/index.ts` is the executable.
- Application `project/project-service.ts` coordinates current membership, replay and transactional commands; `project/kernel-command.ts` maps the public grammar to Domain. `auth/provision-device.ts` owns provisioning.
- Infrastructure `postgres-project-workspace.ts` supplies transaction-bound ports, and `postgres-assistance-jobs.ts` owns lease/budget persistence. Application owns model-job policy; `platform/assistance-worker.ts` only supervises its execution.
- Bridge `runtime/runtime.ts` owns resource lifetime and operation orchestration. `remote/` owns HTTP/receipt handling; existing binding, extraction and Outbox modules retain their policies. `scripts/local-instance.mjs` owns deployment, packaging and encrypted backup operations; `scripts/container/` owns API credential bootstrap.

A package export entry and a process entry have different responsibilities. Neither is a place for unrelated policy or adapter implementation.

### Domain constant ownership

| Values                                                                               | Owner                           | Reason                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------ |
| Kernel event names, persisted event schema version and state-material classification | `state/events.ts`               | Defines the event representation shared by command emission and replay               |
| Initial capture count/time windows                                                   | `state/snapshot.ts`             | Belong to snapshot policy; the kernel uses them when creating project policy         |
| Competitive reactivation and purge windows                                           | `schema/asset.ts`               | Belong to asset lifecycle policy                                                     |
| Equip fact-reference budget                                                          | `state/project-state-kernel.ts` | Used by the issuance command; no independent module is justified by this value alone |
| Hold transition and event/status maps                                                | Kernel-private declarations     | Commands and the applier in this module own the translation                          |
| HTTP defaults and configuration bounds                                               | `platform/config.ts`            | Service-local configuration, not shared domain policy                                |

Constants stay near their owner. Existing modules are preferred over a generic constants file or one file per value. Event classifications expose predicates rather than mutable sets; public event vocabulary is frozen. The public observation grammar belongs to Contracts. Domain owns an observation-validation port; Application supplies the Contracts parser during replay. Domain does not duplicate the public event vocabulary.

## Authority and state flow

```text
actor intent -> transport validation -> Application use case
             -> Domain policy -> transactional port adapter
             -> committed audit event -> rebuilt projection
```

The kernel owns policy and replay but does not own a database connection. Public command dispatch evaluates server-held grants and invokes the kernel inside one project-locked workspace transaction. Project creation, initial membership, directory state and retry outcomes commit with ledger events. A caller must not mistake a successful in-memory kernel call for a durable commit.

Canonical Work Events are observations. Ingest validates and stores their payloads, but it does not execute `submitReturn` or `acceptAsset`. Explicitly validated observations advance the replay cursor without enacting business changes. Domain rejects non-kernel events without a validator. Full replay, snapshot restoration and integrity verification validate all payloads, including snapshot-covered history, and enforce common actor, schema and business-version checks. Ingest copies the committed ledger head's version rather than a possibly older snapshot version. Bridge emits the canonical contract and hashes the complete canonical event. Ingest records authenticated collector attribution and rechecks capture policy.

Version meanings remain separate:

- `seq`: per-project append order and storage concurrency.
- `aggregate_revision` / `run_revision`: object or run concurrency.
- `project_state_version`: selected business-boundary and project-status changes; ordinary activity does not necessarily increment it.
- Snapshot cursor: the event position covered by a replay cache.
- Wire schema and contract versions: compatibility, independent of business progress.

## Snapshot and query boundaries

Domain `state/projection.ts` owns runtime projection shapes; `state/snapshot.ts` validates and restores snapshots; `state/strength.ts` provides deterministic retention advice. Capture orchestration is in Application and consumes EventStore. Capture owns one observation, writes retention annotations before a snapshot, and never deletes ledger events.

Project reads replay a single bounded history observation and return the full projection, independent ledger cursor and business version. Current labels collapse by actual object identity; resolved intended directions leave the intended plane. Asset views apply lifecycle visibility. Directory state is updated in the command transaction. A configured ledger byte limit refuses reads/writes explicitly instead of returning partial authority. Snapshot optimization and long-term archival remain separate capacity work.

Strength is a suggestion signal, not acceptance or automatic retirement. Causal comparison records concurrency; it does not reconcile content. Clock retirement has safety constraints but no executor.

## Trust and runtime boundaries

- Authentication establishes identity; current policy must authorize the operation and resource. Device listing requires a live key; revocation also requires target ownership. Missing and foreign-owned targets receive the same 403 denial, while invalid credentials receive 401.
- Local declarations and client-supplied device IDs are untrusted claims.
- Credentials and unrestricted local content do not belong in telemetry or public errors.
- Retries require idempotency and explicit treatment of unknown outcomes.
- Liveness, dependency readiness, graceful shutdown and durable commit are distinct guarantees.
- Realtime transport, indexes and caches never replace the event authority.

The Compose deployment declares two services in one project: `api` and `postgres`. The API image contains only the built service runtime; PostgreSQL owns a persistent data volume. API bootstrap copies mounted credentials into private volatile storage and drops privileges before importing the API process entry. PostgreSQL startup and shutdown use the database image's entry point. Only the API publishes a loopback host port; the database is available over the Compose network.

Compose owns initial dependency ordering, networking, volumes and each container's restart policy. It waits for PostgreSQL health before starting the API. The API owns its own bounded shutdown and model worker; it keeps serving liveness while database unavailability causes readiness to fail. Healthy probe requests use debug logs, while failures retain normal error classification. Container health does not, by itself, cause Docker to restart a live process. Native Bridge and SQLite remain client-side.

## Local runtime scope

The local profile supports separate human/agent device identities, server-authorized project commands, human review, durable offline observations and explicitly requested model candidates. A background model generation cannot accept assets or execute external tools. Capture supports metadata and local-only policy; raw transcript transfer is not implied.

The verification register is [foundation readiness](foundation-readiness.md); reproducible setup, command examples and restore instructions are in [development](development.md). Browser authorization/UI, public TLS deployment, multi-host availability, general external-tool adapters and release promotion remain separate admission work.

## Database support

The server uses PostgreSQL 15+ semantics, including JSONB, row/advisory locks and PL/pgSQL triggers. Managed PostgreSQL may use the same adapter, subject to engine and permission checks. MySQL and SQL Server adapters are not implemented. Bridge SQLite is device-local storage and cannot replace the server database. Consuming projects connect through contracts and HTTP; their own storage technology is independent.

## Host integration and tooling

Bridge owns platform path resolution and private state access. Windows ACL policy lives in `packages/bridge-daemon/src/security/` and is shipped with the daemon; repository setup invokes the same native policy. Windows pipes are scoped by normalized profile paths, and long Unix profile paths use a bounded socket location. The installed launchers are generated by `scripts/client-installation.mjs` and delegate to a common Node entry. API container bootstrap remains Linux-specific.

The tooling TypeScript project resolves the seven public workspace entries to their source modules for type-aware lint. Production compilation and package exports retain their own build boundaries; lint does not import stale declarations as its source of truth. Native setup/client tests run in the host CI matrix, while database and container deployment checks run in the Linux lane.

`integrations/skills/navis/` contains the optional Agent instructions for the existing CLI. It is a distribution asset, not another workspace or runtime. The instance installer writes the machine's executable invocation only into the explicitly selected installed skill directory. Skill instructions cannot grant membership, change identity or bypass Application/Domain policy; automatic external-tool hook configuration remains separate.

`scripts/package-deployment.mjs` owns package-manager artifact isolation for both API image builds and client installation. It materializes shared hard links, repairs the package's own alias to an internal relative link and refuses other external links. Neither artifact depends on the source checkout after installation.

## Operational records

Compose project/service/replica names describe deployment instances, independently of source packages. Scripts address stable Compose service names. Runtime events go to stdout/stderr and Docker's bounded rotating log driver; application request bodies and credentials are not operational log fields. API process lifecycle emits safe structured outcomes. PostgreSQL keeps failure summaries without default SQL/parameter or failing-row detail dumps. Business events and instance audit stay in their authoritative database stores and survive operational-log rotation. Centralized retention and alerting remain separate production acceptance work.
