# Foundation Design

## Selected standards

- `01-source-code.md`
- `02-testing.md`
- `03-errors-and-observability.md`
- `04-security.md`
- `05-documentation.md`
- `06-contracts-and-compatibility.md`
- `09-dependencies-and-supply-chain.md`
- `10-performance-and-resources.md`
- `11-ci-and-release.md`

Data, asynchronous processing, operations, and UI standards remain mandatory when those boundaries activate, but this change contains no such runtime.

## Workspace boundary

`packages/contracts` is activated because the foundation itself consumes its schemas through tests and future transport implementations. Planned Domain, Application, Infrastructure, Web, API, and Worker boundaries remain only in architecture documentation.

The root TypeScript project is a solution file. Contracts owns its manifest and compiler configuration because it is a real dependency and compilation unit. Directories below `src/` do not own package or compiler configuration.

## Contract profile

### Requests

There is no universal request-body wrapper. Each future operation defines path, query, header, and body schemas according to HTTP semantics. The foundation standardizes request correlation and trace header names plus validated normalized context values.

### Success responses

JSON success responses use:

```json
{
  "data": {},
  "meta": {
    "request_id": "request-identifier"
  }
}
```

Paginated collections add opaque cursor metadata under `meta.page`. Streaming, binary, redirect, and empty responses remain outside the JSON envelope.

### Errors

Errors use RFC 9457 Problem Details and `application/problem+json`. The project profile requires `type`, `title`, `status`, and `request_id`, and permits stable `code`, `trace_id`, and field-level `errors`. Unknown extensions remain valid for forward compatibility. The HTTP status is authoritative.

### Schema authority

Zod 4 is the initial runtime schema authority. TypeScript types are inferred from schemas. JSON Schema generation is deferred until a non-TypeScript consumer exists, as noted in the alternatives below.

Only the JSON-Schema-representable subset of Zod is allowed in public contracts. Runtime transforms, opaque refinements, and defaults that cannot be represented consistently are not public schema authority.

## Toolchain selection

Node.js 24 and pnpm 11 satisfy the current engines of the selected tools. TypeScript 5.9.3 is selected because the current type-aware ESLint parser declares support below TypeScript 6.1; the registry's newest TypeScript is outside that range. Compatibility takes precedence over novelty.

TypeScript Project References own build ordering. dependency-cruiser owns import-direction checks. ESLint owns source correctness rules; Prettier owns formatting; Vitest owns tests and coverage. No task-cache framework is introduced without measured need.

## Alternatives

- **Interfaces without runtime schemas:** rejected because untrusted wire data remains unchecked.
- **JSON Schema first with a separate validator:** viable for a multilingual contract program, but adds two tools before a non-TypeScript consumer exists. Revisit when that consumer appears.
- **A complete resource protocol:** deferred because resource relationships are unknown.
- **One generic success/error envelope with HTTP 200:** rejected because it conflicts with HTTP and RFC 9457 semantics.
- **Activate all planned packages:** rejected because package configuration without executable responsibility is not architecture enforcement.

## Evidence base

- RFC 9110 for HTTP semantics and status behavior.
- RFC 9457 for Problem Details and extension/security behavior.
- W3C Trace Context for distributed trace headers.
- Current package engine and peer-dependency declarations for toolchain compatibility.

## Open questions

- Which first business contract provides independent user value?
- When will a non-TypeScript consumer require JSON Schema-first authority or generated clients?
- Which API runtime will bind these schemas to actual requests and responses?
