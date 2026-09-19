# Specification: bridge-session-hook

## ADDED Requirements

### Requirement: session-start hook contract

The contract package SHALL define a schema `bridgeHookInvocationSchema` whose shape is `{ hook: 'session.start'; project_id; request_id }` with `request_id` being an idempotency envelope, and a schema `bridgeHookResultSchema` with shape `{ status: 'started' | 'reused' | 'failed'; pid?: number; reason?: string }`. Both shapes are closed schemas; any extra key fails validation.

#### Scenario: well-formed invocation validates

- **WHEN** a runtime calls the hook with `{ hook: 'session.start', project_id: '<uuid>', request_id: '<uuid>' }`
- **THEN** `bridgeHookInvocationSchema.safeParse(...)` returns success

#### Scenario: malformed invocation is rejected

- **WHEN** the hook field is anything else or any extra key appears
- **THEN** `safeParse` returns success=false
- **AND** the contract validation error enumerates the offending path

#### Scenario: result shape covers all three outcomes

- **WHEN** the hook execution ends
- **THEN** a status of `started`, `reused`, or `failed` is emitted
- **AND WHEN** status is `started` or `reused`
- **THEN** `pid` is a positive integer
- **AND WHEN** status is `failed`
- **THEN** `reason` is a non-empty bounded text
