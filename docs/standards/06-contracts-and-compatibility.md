# Contracts and compatibility standard

## Contract authority

- Every public request, response, event, and error has one runtime-validatable schema. TypeScript types are inferred from runtime schemas.
- Separately maintained validation and interfaces may not drift from the runtime schema.
- Each operation owns its request schema. Do not force path, query, headers, and body into a universal request envelope.
- Common transport concerns use standard headers and media types. JSON success responses use the reviewed response profile; errors use RFC 9457 Problem Details.
- Binary, streaming, event-stream, redirect, and empty responses follow HTTP semantics and do not receive a JSON wrapper.
- Machine-readable schema generation (e.g. JSON Schema) is introduced only when a non-TypeScript consumer exists and requires an ADR.

## HTTP response profile

- JSON success bodies use `{ data, meta }`. `meta.request_id` is present; trace and pagination metadata are added only when applicable.
- Collection pagination uses opaque cursors. Clients do not construct or decode cursor contents.
- HTTP status, method, cache, conditional request, content negotiation, and retry headers retain their standard meaning; a body field may not contradict them.
- Problem Details uses `application/problem+json`. `type` is the primary identifier, `title` is stable for that type, `status` matches HTTP status, and `detail` is safe human guidance.
- Field validation problems use a documented extension with JSON Pointer locations. Clients ignore unknown Problem Details extensions.

## Evolution

- Compatibility is evaluated for producers and consumers independently. Adding an optional field is compatible only when consumers ignore unknown fields.
- Removing, renaming, narrowing, changing meaning, changing default behavior, or making an optional field required is breaking.
- Public identifiers, timestamps, numeric precision, nullability, ordering, pagination, and error semantics are explicit.
- Events include stable type and schema version. Consumers handle additive fields and reject unsupported incompatible versions predictably.
- Deprecation states replacement, owner, announcement point, telemetry, and removal condition. Time alone does not prove safe removal.

## Verification

CI validates runtime parsing, representative examples, producer conformance, consumer compatibility, media types, and public error mapping. Review classifies every public contract change.

## Normative references

- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
