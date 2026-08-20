# ADR-0003: HTTP contract profile

- Status: Proposed
- Date: 2026-08-19

## Context

Future services and clients need one interoperable response and error profile. A universal request/response wrapper invented before operations exist would obscure HTTP method, path, query, header, caching, streaming, and status semantics. Types without runtime schemas would allow wire behavior to drift from TypeScript declarations.

## Proposed decision

1. Each operation owns its request schema. Common request context uses headers rather than a universal request-body envelope.
2. JSON success responses use `{ data, meta }`; `meta.request_id` is required. Paginated collections add `meta.page` with opaque cursors.
3. Empty, binary, redirect, and streaming responses follow HTTP semantics and do not use the JSON success envelope.
4. HTTP errors use RFC 9457 Problem Details and `application/problem+json`. Project extensions are `code`, `request_id`, `trace_id`, and validation `errors` with JSON Pointer locations.
5. W3C `traceparent` and `tracestate` carry distributed trace context. `x-request-id` is a separate correlation identifier.
6. Zod 4 schemas are the runtime authority for the initial Contracts package. TypeScript types are inferred from schemas. JSON Schema generation is deferred until a non-TypeScript consumer exists.
7. Public response schemas accept unknown additive fields for compatible evolution. Request schemas are strict unless a contract explicitly permits extensions.

## Consequences

Services receive a reusable, validated foundation without freezing business payloads. Errors interoperate with standard HTTP tooling and preserve stable machine identifiers. The schema dependency remains isolated in Contracts.

HTTP status remains authoritative if it conflicts with the Problem Details `status` member. Services must test that they never emit such a mismatch.

## Alternatives

- **Always return HTTP 200 with `{ success, error }`:** rejected because it breaks HTTP intermediaries, monitoring, and status semantics.
- **Wrap every request in `ApiRequest<T>`:** rejected because transport concerns have different locations and semantics.
- **Use TypeScript interfaces only:** rejected because interfaces do not validate runtime input or generate language-neutral schemas.
- **Adopt a complete resource protocol now:** deferred until resource relationships and client needs are known.

## References

- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
