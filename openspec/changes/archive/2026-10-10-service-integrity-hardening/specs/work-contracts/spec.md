## ADDED Requirements

### Requirement: session privacy payloads obey producer and consumer tolerance

Canonical Work Event producers SHALL reject undeclared fields within session privacy metadata for every session-internal event type. Consumers SHALL ignore those fields at a supported version while validating all declared fields. Persisted payload validation SHALL use the same strict variant schemas as production.

#### Scenario: undeclared nested privacy data cannot be produced

- **WHEN** a session event carries an undeclared field inside `payload.privacy`
- **THEN** strict production rejects the event
- **AND** tolerant consumption removes the extra field and preserves the declared metadata

#### Scenario: a persisted payload has an unknown type or invalid declared field

- **WHEN** persisted payload validation receives an unknown event type or malformed privacy metadata
- **THEN** validation rejects it rather than treating it as an opaque observation
