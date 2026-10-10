# Architecture baseline

## Status

Reviewed on 2026-10-10. This document separates implemented modules from the intended process composition. Remaining integration and release gates are recorded in [foundation readiness](foundation-readiness.md).

There are seven source-bearing workspace units. The API and local integration packages exist. Web and Worker remain planned. The ten ADR files retain their recorded `Proposed` status; implementation or OpenSpec archive status does not silently accept an ADR.

| Boundary       | Current implementation                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain         | Object schemas, single-project kernel, event history and replay, acceptance/delivery/hold gates, WorkRun/intervention, causal clocks, snapshot policy, strength advice, closed vocabulary |
| Contracts      | Runtime schemas for transport primitives, Canonical Work Events, public Equip and Return, ingest, project query, device authorization and session hook                                    |
| Application    | Snapshot capture, injected command dispatch, batch ingest, project queries, device authentication                                                                                         |
| Infrastructure | In-memory and PostgreSQL persistence ports, SQL migrations, transaction-bound command intake                                                                                              |
| API            | HTTP listener, authenticated route composition, adapter construction and resource cleanup                                                                                                 |
| Bridge daemon  | Local IPC/lifecycle, bindings, keychain, SQLite Outbox, upload tick, extraction and context cache; business process composition is incomplete                                             |
| CLI            | Public export entry and command invocation module; the declared executable is not present                                                                                                 |
| Web / Worker   | No source workspace; user workflow and runtime admission remain outstanding                                                                                                               |

## System ownership

The intended product separates local execution from shared project authority:

```text
Human -> Web control plane -> API command/query boundary
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

This is an ownership diagram, not a claim that all arrows currently run. The service owns project state, accountable review and business audit. The Bridge owns device-local access, consent, credentials and offline transfer. The external Agent runtime owns its execution session. A synchronization acknowledgment records transport success; it does not accept a candidate or confirm delivery.

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

The intended local integration boundary consumes public contracts. The current Bridge package also imports Domain's lifecycle interface, and CLI imports Bridge and Contracts. Their eventual distribution boundary and the lifecycle contract's ownership need explicit review before package publication.

Only `services/api/src/platform/composition.ts` may import Infrastructure inside the API source tree. It constructs the concrete adapters; other API modules consume public contracts, use cases and ports. The composition module is itself restricted to the four admitted server packages. TypeScript references follow the same build dependencies.

## Package and module depth

A workspace package is a compilation, dependency, deployment, publication, trust or ownership boundary. Internal capabilities do not receive their own package manifests or compiler configuration.

A new workspace unit requires a concrete consumer or independent runtime, release or ownership responsibility. Source grows by capability and then use case. Generic `utils`, `helpers`, `shared` and placeholder source directories do not establish ownership.

### Service entry and module ownership

- `platform/index.ts` is a process entry: load configuration, start the runtime and handle signals.
- `platform/composition.ts` constructs adapters, runs migrations and releases the pool after HTTP shutdown or failed startup. Its signatures expose runtime behavior and ports, not concrete adapter unions.
- `platform/routes.ts` installs the route factories and request-local identity scope. Ingest membership is checked against the event projects; the claimed device must match the authenticated caller.
- `platform/config.ts` owns this service's environment mapping, defaults and startup validation. A supplied database URL must be a PostgreSQL URL; absence retains the current in-memory mode.
- `packages/cli/src/index.ts` is a package export entry. Invocation parsing and dispatch live in `commands/invocation.ts`.

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

The kernel owns policy and replay but does not own a database connection. Command dispatch wraps an injected executor; the general public-command-to-ledger mapping remains unimplemented. A caller must not mistake a successful in-memory kernel call for a durable commit.

Canonical Work Events are observations. Ingest validates and stores their payloads, but it does not execute `submitReturn` or `acceptAsset`. Explicitly validated observations advance the replay cursor without enacting business changes. Domain rejects non-kernel events without a validator. Full replay, snapshot restoration and integrity verification validate all payloads, including snapshot-covered history, and enforce common actor, schema and business-version checks. Ingest copies the committed ledger head's version rather than a possibly older snapshot version. The complete client producer and query read model still require integration.

Version meanings remain separate:

- `seq`: per-project append order and storage concurrency.
- `aggregate_revision` / `run_revision`: object or run concurrency.
- `project_state_version`: selected business-boundary and project-status changes; ordinary activity does not necessarily increment it.
- Snapshot cursor: the event position covered by a replay cache.
- Wire schema and contract versions: compatibility, independent of business progress.

## Snapshot and query boundaries

Domain `state/projection.ts` owns runtime projection shapes; `state/snapshot.ts` validates and restores snapshots; `state/strength.ts` provides deterministic retention advice. Capture orchestration is in Application and consumes EventStore. Capture owns one observation, writes retention annotations before a snapshot, and never deletes ledger events.

The service's current project query computes a business version through replay, then returns event labels grouped by family. It does not expose the complete kernel projection, and its current helper does not consume snapshots. Project directory search reads the relational project/member tables; a complete projection-writer path remains outstanding.

Strength is a suggestion signal, not acceptance or automatic retirement. Causal comparison records concurrency; it does not reconcile content. Clock retirement has safety constraints but no executor.

## Trust and runtime boundaries

- Authentication establishes identity; current policy must authorize the operation and resource. Device listing requires a live key; revocation also requires target ownership. Missing and foreign-owned targets receive the same 403 denial, while invalid credentials receive 401.
- Local declarations and client-supplied device IDs are untrusted claims.
- Credentials and unrestricted local content do not belong in telemetry or public errors.
- Retries require idempotency and explicit treatment of unknown outcomes.
- Liveness, dependency readiness, graceful shutdown and durable commit are distinct guarantees.
- Realtime transport, indexes and caches never replace the event authority.

The root Compose file is a local-development convenience with loopback-only published ports. It runs the checkout's built API with PostgreSQL; it does not build an immutable product image. No complete external cloud deployment or production release is established by its existence.

## Remaining admission and acceptance work

1. Complete browser authorization and reconcile the full project read model with the accepted requirements.
2. Verify the actual API and CLI process composition and built-package contents.
3. Exercise the real Bridge producer against the real service response contract.
4. Introduce the first human review workflow and asynchronous use case under their own reviewed behavior and runtime choices.
5. Supply deployment, backup/restore, operational and release evidence before a production claim.
