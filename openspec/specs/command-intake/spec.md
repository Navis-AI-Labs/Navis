# command-intake Specification

## Purpose

TBD - created by archiving change command-intake-idempotency. Update Purpose after archive.

## Requirements

### Requirement: the command inbox port claims or replays idempotent submissions

The system SHALL define a `CommandInbox` output port in the domain layer, scoped per project, with a begin operation taking (project id, idempotency key, command type, payload hash) and a complete operation taking (project id, idempotency key, terminal status, outcome). Begin SHALL return exactly one of: `fresh` (the claim is installed; the caller must complete it), `replay` with the stored outcome (a prior submission with the same key and identical payload hash already reached a terminal status), or `processing` (a prior claim with the same key with identical payload hash exists but is not yet terminal — the caller does not execute and may retry later). A beginning call whose single key already exists with a DIFFERENT payload hash SHALL be refused explicitly as a key-collision failure. Completing with a terminal status SHALL store the outcome for later replay; completing an unknown key SHALL be refused loudly. Every adapter SHALL satisfy this identical semantic contract, tested by one shared suite.

#### Scenario: first submission claims fresh

- **WHEN** begin is called for a key the inbox has never seen
- **THEN** it returns `fresh` exactly once for that key across any number of concurrent attempts

#### Scenario: identical resubmission replays the first outcome

- **WHEN** a submission whose key and payload hash already reached `applied` is re-begun
- **THEN** begin returns `replay` with the originally stored outcome and no new claim state is created

#### Scenario: in-flight claim blocks re-entry

- **WHEN** a submission is re-begun while its earlier claim is still in the received (non-terminal) state
- **THEN** begin returns `processing` and the caller does not execute the command

#### Scenario: same key, different payload is refused

- **WHEN** begin arrives with an idempotency key already stored and a payload hash that does not match
- **THEN** the call fails with an explicit payload-collision signal and no claim or outcome changes

### Requirement: the dispatch use case applies each submission exactly once

The Application dispatch use case SHALL take a command payload plus its idempotency key and a caller-supplied executor, and SHALL drive: inbox begin → only on `fresh`, invoke the executor exactly once → mark the claim `applied` carrying the executor's success outcome; on an executor rejection the claim is marked `failed` with the rejection outcome stored. A retried submission SHALL return the stored outcome and SHALL NOT re-invoke the executor; the use case SHALL treat a `processing` begin response as a typed in-flight signal, never as success or failure. The idempotency key SHALL be required on this path. How the executor turns a command into ledger writes is owned by the (future) command-persistence composition, not by this capability — this change guarantees the once-only wrapping, not the command mapping.

#### Scenario: dispatch executes once and records the outcome

- **WHEN** a submission is dispatched with a new idempotency key
- **THEN** the executor runs exactly once and the claim is marked `applied` with the stored outcome

#### Scenario: resubmission returns the first outcome without re-executing

- **WHEN** the identical submission is dispatched again after success
- **THEN** the returned outcome equals the first outcome and the executor has not been invoked a second time

#### Scenario: a submission without an idempotency key cannot enter

- **WHEN** dispatch is asked to process a command without an idempotency key
- **THEN** it refuses before any claim, kernel call, or append happens

#### Scenario: a rejected submission replays its rejection

- **WHEN** the executor rejects a dispatched submission and the identical submission arrives again later
- **THEN** the second dispatch returns the recorded failure outcome and the executor is not re-invoked

### Requirement: payload fingerprinting is canonical and same-key collision is loud

The idempotency comparison SHALL hash the submission through canonical JSON (sorted keys, recursively) with SHA-256 so two wire-equal submissions always agree regardless of key order. A nonempty string idempotency key and this hash SHALL form the stored claim identity; status, command type, and the outcome reference round-trip losslessly through both adapters, and concurrent racing claims under the Postgres adapter SHALL resolve through the unique-key constraint with at most one winner.

#### Scenario: key order does not change the fingerprint

- **WHEN** two byte-different but field-order-different command payloads are fingerprinted
- **THEN** their payload hashes are identical

#### Scenario: concurrent first-claims have one winner

- **WHEN** two dispatch paths begin the same new key at the same time
- **THEN** exactly one observes `fresh`, the other observes `processing` or `replay`, and the ledger ends applied exactly once
