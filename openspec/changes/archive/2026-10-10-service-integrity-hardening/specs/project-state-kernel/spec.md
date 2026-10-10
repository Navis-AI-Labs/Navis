## ADDED Requirements

### Requirement: persisted observations are validated without enacting commands

Replay SHALL validate every non-kernel event through an explicitly supplied observation validator. Absent validation, unsupported types and invalid payloads SHALL fail closed. Full replay, snapshot restoration and integrity verification SHALL validate the complete log, including snapshot-covered observations. Valid observations SHALL advance ledger sequence and registered-actor causal authorship without changing project business state; existing actor, schema-version and state-version checks SHALL apply.

#### Scenario: a valid observation survives every recovery path

- **WHEN** an explicitly validated observation follows valid project history
- **THEN** full and snapshot-assisted replay produce the same projection and causal clock
- **AND** business state and version remain unchanged

#### Scenario: a snapshot cannot hide malformed history

- **WHEN** an observation has malformed payload data before or after the snapshot cursor
- **THEN** restoration rejects the log with the invalid event sequence identified

#### Scenario: unknown observations cannot pass by default

- **WHEN** replay encounters a non-kernel event without a validator or with a type its validator rejects
- **THEN** replay rejects it without returning a reconstructed kernel
