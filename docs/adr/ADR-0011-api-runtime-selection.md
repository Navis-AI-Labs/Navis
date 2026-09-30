# ADR-0011: API runtime selection

- Status: Proposed
- Date: 2026-09-26

## Context

The active change `bridge-remote-sync-ingest` admits `services/api`, the first service process in the repository. ADR-0004 forbids selecting an API runtime before its first accepted use case exists; the change's accepted ingest, query, and auth requirements are that use case. Until this ADR is accepted, no `services/api` source may exist.

The service's requirements, fixed by the change's spec, constrain the choice:

- A single `POST /api/ingest` accepts a batch and reports per-event acceptance/rejection. The response shape is heterogeneous — some events append, some are rejected with stable tokens — so the response is composed by application code, never by a framework-level serializer that assumes one outcome per request.
- `get_project_state`, `load_context`, `search_projects`, and the OAuth device-flow endpoints are independent operations with independent request schemas. ADR-0003 already forbids a universal request envelope; each operation owns its schema.
- Errors follow RFC 9457 Problem Details with project extensions (ADR-0003). The transport must not inject framework-specific error shapes into the response.
- Every protected route authenticates a device key and authorizes against the membership table. The middleware chain is a cross-cutting guard, not a routing concern.
- Foundation readiness requires typed startup-validated configuration, structured logs with redaction, W3C trace context, health/readiness probes, and graceful shutdown before any business handler.

## Decision drivers (ADR-0004 evidence points)

1. **Required behavior and failure semantics** — the batch-with-partial-result contract and per-event rejection are the load-bearing behavior. The runtime must let the handler produce a composed response and must not assume one-status-per-request. Request body handling must be fully controllable, because per-event validation happens after the whole batch is parsed.
2. **Trust and deployment boundary** — the service terminates an untrusted network boundary. Request validation is the zod schema; errors must never carry framework internals (standard 03). A runtime that leaks its own error objects into responses is disqualified.
3. **Concrete consumers** — exactly one consumer exists: the bridge daemon over JSON/HTTP. A second consumer (a future web app) consumes the same public schemas, never framework types. Consumer count does not justify framework weight today.
4. **Alternatives and evaluation evidence** — three candidates below, scored against drivers 1, 2, and 6.
5. **Operational ownership** — whatever is chosen must meet standard 12 (typed validated configuration, structured logging hooks, liveness/readiness, graceful shutdown) without bespoke plumbing. A runtime needing a wrapper to satisfy these is rejected.
6. **Exit cost** — the adapter layer is the swap boundary: request parsing, response serialization, and error mapping sit in one module; application code and contracts survive a runtime swap. A choice is admissible only if the swap cost is bounded to that module.

## Proposed decision

Select **`node:http` (Node's built-in HTTP server)** as the API runtime for `services/api`.

1. The service is a thin adapter over `node:http`: one request listener, a route table keyed by `METHOD + path`, body reading via the standard stream events, response writing via the standard `Response`-shaped helpers. No framework dispatches, serializes, or maps errors on our behalf.
2. **Rationale for the built-in over a framework**:
   - The contract surface is small (one batch endpoint plus a handful of query/auth endpoints) and already fully specified by zod schemas. A framework's routing, validation, and serialization layers would duplicate schemas ADR-0003 already assigned to contracts, and its opinionated response pipeline fights the per-event-rejection shape.
   - `node:http` carries zero supply-chain surface: no new runtime dependency, no version pin, no security history to review, no native modules. Standard 09 admits a dependency only for a concrete capability that the platform lacks; the platform does not lack an HTTP server.
   - The failure semantics are fully ours: every status code, every Problem Details body, and every rejection token is produced by code this repository owns and tests. Nothing can leak framework internals because there is no framework layer in between.
   - Exit cost is provably bounded: the adapter module is the only `node:http` consumer; replacing it with a framework later re-implements that module alone. The contracts, application use cases, and spec scenarios are untouched.
3. **Foundation wiring is explicit, not magical** — configuration validation at startup, a structured log emitter (JSON lines, redaction by config allowlist), `traceparent` extraction from request headers, `/healthz` and `/readyz` routes, and signal-driven shutdown are written as ordinary modules in the service. They are testable without a running server and reviewed against standard 12 directly.
4. **Streaming and large payloads** (standard 10) — batch size is bounded by the contract; oversized requests are refused by a content-length check before the body is read. No unbounded buffering.
5. **Authorization is a guard, not a feature** — every route lookup resolves a guard that authenticates the device key and enforces membership; routes without a guard are explicitly enumerated and tests prove the unauthenticated path is denied (standard 04 negative tests).

## Consequences

- `services/api` gains no runtime dependency beyond `zod` (already in contracts) and workspace packages. The dependency-cruiser rule `services-api-imports-only-public` keeps the service off concrete adapters.
- More adapter code is written by hand than a framework would generate — a route table, a body reader, and an error mapper. This is deliberate: the code is small, fully testable, and matches the spec exactly.
- Every scenario in the change spec is verifiable against a real `node:http` listener with no framework abstractions in the way (standard 02: observable behavior at the narrowest layer).
- If a future change needs framework-grade features (multipart, WebSocket, load-tuned streaming), it re-opens this ADR rather than adding the framework silently.

## Alternatives

- **Fastify** — fast, mature plugin ecosystem, schema-aware serialization. **Rejected**: its serializer and error handling assume one outcome per request and must be fought for the per-event rejection contract; its response pipeline can emit framework-shaped errors unless suppressed; and it adds a runtime dependency with a plugin surface this service does not need. Exit cost is real but the benefit over `node:http` is zero for four endpoints.
- **Hono** — minimal, standards-aligned, pleasant API. **Rejected**: its router and context objects interpose between our zod schemas and the wire, and its error-to-response mapping is another layer to override. The standards-alignment argument is not worth the dependency for a service whose entire contract is already defined in contracts.
- **Node's `node:http` + a routing micro-library** — considered and folded into the decision: the route table is ~30 lines and tests cover it; a routing library would add a dependency to save code that is already proven.

## References

- ADR-0003 HTTP contract profile (envelope, Problem Details, trace context)
- ADR-0004 Runtime selection gates (evidence points)
- `docs/foundation-readiness.md` — "First service process" rows
- `docs/standards/03-errors-and-observability.md`, `04-security.md`, `09-dependencies-and-supply-chain.md`, `12-operations.md`
- Active change `bridge-remote-sync-ingest` spec (ingest, query, auth requirements)
