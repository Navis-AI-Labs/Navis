# Architecture baseline

## Status

This document is a reviewable architecture baseline. It defines stable ownership and dependency rules while leaving unresolved business and runtime decisions explicit.

| Area                                                          | Status                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| Project concept                                               | Defined in the root README                                     |
| Repository dependency direction                               | Proposed in ADR-0001                                           |
| Workspace and TypeScript toolchain                            | Proposed in ADR-0002                                           |
| HTTP contract profile                                         | Proposed in ADR-0003 and implemented as a foundation candidate |
| Web, API, Worker, persistence, and local integration runtimes | Deferred by ADR-0004                                           |
| Business domain behavior                                      | Not implemented                                                |

## System context

```text
Human participants
        |
        v
Web control plane ---- public contract ---- service command/query boundary
                                               |
                                      Application use cases
                                               |
                                         Domain policy
                                               |
                                       output ports only
                                               |
                                        Infrastructure

Local Agent runtimes ---- local integration boundary ---- public contract
```

The future service trust domain owns authoritative Project records, accountable review, audit history, and Delivery records. A future local integration component owns device access, local policy, credentials, and offline transfer. An Agent runtime owns its execution session. Supporting runtimes never become Project State authority.

## Logical ownership

| Boundary        | Owns                                                           | Must not own                                                      |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Web application | Human-facing Project, review, and Delivery workflows           | Domain mutation, database access, local Agent execution           |
| API service     | Transport mapping, authentication integration, and composition | Domain policy or direct persistence writes from handlers          |
| Worker service  | Retryable background entry points and composition              | Acceptance authority or silent state mutation                     |
| Domain          | Framework-independent business policy and valid transitions    | HTTP, persistence, filesystem, queue, model, or Agent integration |
| Contracts       | Versioned public requests, responses, events, and errors       | ORM entities, server-private classes, or Domain implementation    |
| Application     | Use-case orchestration and output ports                        | Concrete transport, storage, queue, or framework code             |
| Infrastructure  | Implementations of Application ports                           | New business policy or public contract ownership                  |

Only Contracts is currently activated as source code because the foundation change gives it a concrete consumer and executable requirements. Other boundaries remain architecture, not empty directories.

## Compile-time dependency direction

In this graph, `A -> B` means that `A` may import `B`.

```text
web ------------------------------------> contracts

api ----------+------------------------> contracts
              +------------------------> application
              `------------------------> infrastructure

worker -------+------------------------> contracts
              +------------------------> application
              `------------------------> infrastructure

infrastructure +-----------------------> application
               +-----------------------> domain
               `-----------------------> contracts

application ---+-----------------------> domain
               `-----------------------> contracts

domain --------------------------------> no Navis package
contracts -----------------------------> no server implementation package
```

Domain and Contracts are separate foundations. Public schemas remain consumable without importing server business implementation. Application owns output ports; Infrastructure implements them; deployable services are composition roots.

## Package and module depth

A workspace package is a real dependency and compilation boundary. A module is an internal capability directory. These are intentionally different levels.

A new workspace unit requires at least one of:

- an independent consumer;
- a distinct runtime dependency set;
- an independent build, test, deployment, or publication boundary;
- a separate ownership, permission, or trust boundary;
- a different release cadence.

When a workspace unit is admitted, internal source grows from accepted behavior:

```text
<workspace-unit>/
├── package.json
├── tsconfig.json
└── src/
    ├── <capability>/
    │   └── <use-case>/       # only when the capability needs this depth
    └── <another-capability>/
```

Internal modules do not receive package manifests or compiler configurations. Generic `types`, `utils`, `helpers`, and `shared` directories are not default architecture; shared code stays with its owner until multiple concrete consumers prove a narrower abstraction.

## Authority and state flow

The current project-level invariants are intentionally narrower than a complete domain model:

- Project continuity does not belong to one Agent Session.
- Candidate material cannot silently become authoritative state.
- Acceptance is an accountable decision, not an executor status.
- Artifact existence is not Delivery.
- Memory, indexes, and projections are derived rather than authoritative.

A future mutation path is constrained without selecting a transport or database:

```text
actor intent
  -> transport validation and mapping
  -> Application command
  -> Domain policy
  -> Application output ports
  -> transactional Infrastructure adapter
  -> audit and observable result
```

Queries may use projections but may not bypass this path to mutate authority. A Worker or local adapter may submit evidence or Candidate material through an authorized use case; it cannot write authoritative state directly.

The exact aggregates, fields, transactions, Candidate lifecycle, Artifact lifecycle, and Acceptance-to-Delivery relationship remain OpenSpec questions. No placeholder source model may freeze them.

## Public contract boundary

The activated Contracts package provides only business-neutral transport primitives:

- standard request-context header names and validators;
- JSON success response metadata and factories;
- opaque cursor pagination metadata and factories;
- RFC 9457 Problem Details with safe project extensions.

It does not define Project, Work, Candidate, Acceptance, Artifact, or Delivery payloads. Those appear only after their behavior is accepted. JSON Schema generation is deferred until a non-TypeScript consumer exists.

## Trust, failure, and security

- External input remains untrusted after authentication and is validated at every changed representation.
- Credentials and unrestricted local content do not enter public contracts, telemetry, or errors.
- HTTP status remains authoritative; an error body cannot redefine transport success or failure.
- Retries require explicit idempotency and side-effect semantics.
- Infrastructure failure cannot be translated into a successful Domain transition.
- Realtime delivery is a projection mechanism, not the source of truth.
- Production claims require the applicable evidence in `docs/foundation-readiness.md`.

## Intended repository evolution

```text
Navis/
├── packages/
│   ├── contracts/          # active foundation candidate
│   ├── domain/             # create with first accepted Domain behavior
│   ├── application/        # create with first accepted use case
│   └── infrastructure/     # create with first selected external adapter
├── services/
│   ├── api/                # create after API runtime ADR
│   └── worker/             # create after asynchronous use case and runtime ADR
└── apps/
    └── web/                # create after an accepted user workflow and Web ADR
```

This tree is a plan, not the current filesystem. Planned boundaries stay here until activated.

## Stage gates

1. **Foundation baseline:** repository governance, strict toolchain, contract primitives, schema generation, and quality gates.
2. **Behavior baseline:** accept the smallest valuable user and Domain behavior in OpenSpec.
3. **Boundary activation:** create only the packages or processes required by that behavior and accepted ADRs.
4. **Vertical implementation:** implement the behavior with focused, contract, integration, and failure tests.
5. **Production readiness:** complete security, migration, reliability, performance, release, and operational evidence for every activated runtime.

## Open decisions

- The first independently valuable user workflow and Artifact.
- Domain aggregate and transaction boundaries.
- The exact relationship among Result, Candidate, Artifact, Acceptance, and Delivery.
- Public API and event versioning beyond the common foundation.
- API and Web frameworks.
- Persistence engine mapping and migration tooling.
- Worker and durable workflow runtime.
- Identity, tenancy, and authorization model.
- Local integration runtime and release boundary.
