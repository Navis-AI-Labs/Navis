# foundation Spec Delta

## MODIFIED Requirements

### Requirement: JSON responses use the common transport profile

The Contracts package SHALL provide a success response factory, a cursor-page response factory, and an RFC 9457 Problem Details schema. These transport-profile primitives remain business-neutral; business payloads are defined by the `work-contracts` capability and use these primitives for their wire representation without diluting them.

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
- **AND** it SHALL accept unknown extension members as defined by RFC 9457
