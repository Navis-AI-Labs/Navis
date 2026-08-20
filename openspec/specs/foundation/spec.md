# Foundation Specification

## Purpose

Production foundation requirements for the Navis repository: workspace admission, contract schema authority, transport profile, request correlation, and the single reproducible quality gate.

## Requirements

### Requirement: only admitted workspace units materialize in the code tree

The repository MUST contain source directories and package-level configuration only for workspace units with executable responsibility in an active or accepted change.

#### Scenario: a planned boundary has no implementation responsibility

- **WHEN** architecture describes a future application, service, or package
- **AND** no active or accepted change assigns it executable responsibility
- **THEN** the repository MUST NOT create its code directory, manifest, compiler configuration, or placeholder README

#### Scenario: Contracts is activated by the foundation change

- **WHEN** Contracts owns runtime schemas and tests required by this change
- **THEN** it MUST have an explicit workspace manifest, compiler boundary, public exports, and verification commands

### Requirement: public contract types and runtime schemas share one authority

The Contracts package SHALL infer TypeScript wire types from runtime schemas. TypeScript types and runtime validation SHALL not drift from each other.

#### Scenario: a value is accepted at runtime

- **WHEN** a Contracts runtime schema accepts a value
- **THEN** the returned value SHALL conform to the TypeScript type inferred from that schema

### Requirement: JSON responses use the common transport profile

The Contracts package SHALL provide a success response factory, a cursor-page response factory, and an RFC 9457 Problem Details schema without defining business payloads.

#### Scenario: a JSON success response is created

- **WHEN** an operation wraps a valid business payload with the success response factory
- **THEN** the response SHALL place the payload under `data`
- **AND** it SHALL include `meta.request_id`

#### Scenario: a paginated JSON response is created

- **WHEN** an operation wraps a collection with the cursor-page response factory
- **THEN** the response SHALL place opaque cursor state under `meta.page`
- **AND** clients SHALL NOT require cursor contents to have a public structure

#### Scenario: an HTTP problem is represented

- **WHEN** a service represents a public HTTP failure
- **THEN** the body SHALL validate as the project RFC 9457 Problem Details profile
- **AND** it SHALL support unknown extension members for forward compatibility

### Requirement: request correlation follows standard transport boundaries

The Contracts package SHALL define normalized request correlation values and standard header names without treating request IDs as distributed trace context.

#### Scenario: a request has W3C trace context

- **WHEN** valid `traceparent` or `tracestate` headers are supplied
- **THEN** they SHALL remain distinct from `x-request-id`

#### Scenario: normalized correlation values exceed their limits

- **WHEN** a request ID, trace ID, trace header, or idempotency key exceeds its documented bound
- **THEN** runtime validation SHALL reject the value

### Requirement: the foundation has one reproducible quality gate

The repository SHALL provide a full validation command that checks formatting, lint, types, dependency boundaries, tests, coverage, build output, and OpenSpec structure.

#### Scenario: a contributor uses only repository-declared tools

- **WHEN** dependencies are installed from the committed lockfile
- **THEN** the full validation command SHALL run without a globally installed project tool

#### Scenario: a required check fails

- **WHEN** any selected quality check reports failure
- **THEN** the full validation command SHALL exit unsuccessfully
