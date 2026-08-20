# ADR-0004: Runtime selection gates

- Status: Proposed
- Date: 2026-08-19

## Context

The architecture anticipates Web, API, Worker, persistence, identity, object storage, and local integration concerns. Selecting frameworks and vendors before the first accepted behavior would turn assumptions into expensive defaults.

## Proposed decision

Do not select or scaffold a Web framework, API framework, ORM, database mapping, queue, Worker runtime, durable workflow engine, identity provider, object store, or local integration runtime in the foundation baseline.

A runtime is selected only when its first accepted use case identifies:

- required behavior and failure semantics;
- trust and deployment boundary;
- concrete consumers;
- alternatives and evaluation evidence;
- operational ownership and exit cost;
- applicable standards and verification plan.

The corresponding source boundary does not exist until its ADR is accepted. Generic logger, config, repository, workflow, or service-base packages are not created in anticipation.

## Consequences

The repository can establish contracts and quality gates without pretending that business and runtime questions are resolved. Service-specific production foundations must still be completed before business code in that service, as tracked by `docs/foundation-readiness.md`.

## Alternatives

- **Use a minimal HTTP server and memory store as defaults:** rejected because a temporary default still fixes transport and transaction assumptions.
- **Select the full production stack now:** rejected because no accepted vertical behavior provides evaluation criteria.
- **Leave gates undocumented:** rejected because contributors would make incompatible local choices.
