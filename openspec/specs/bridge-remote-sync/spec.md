# bridge-remote-sync Specification

## Purpose

Bridge daemon → ingest pipeline: capture session process into the Outbox
with bounded-batch upload, ack-then-delete, and idempotent dedup
(event_id, device_id) into the project ledger.

## Requirements

### Requirement: ingest accepts event batches and deduplicates on (event_id, device_id)

The service SHALL accept `POST /api/ingest` with a batch of Canonical Work Events (envelope per `work-contracts`). Events with a `(event_id, device_id)` pair already present in the ledger SHALL be acknowledged as duplicates, not errors, and SHALL NOT be appended again. Surviving events SHALL append to the project's event ledger atomically per batch. A duplicate event in the same batch as new events SHALL NOT block the new events.

#### Scenario: a batch of new events is appended

- **WHEN** the client posts a batch of three well-formed events for a project the caller's device may write
- **THEN** all three append to the ledger under the project
- **AND** the response reports three accepted and zero rejected

#### Scenario: an already-known event is a duplicate, not an error

- **WHEN** the client posts an event whose `(event_id, device_id)` already exists in the ledger
- **THEN** the response lists it as a duplicate
- **AND** the ledger is unchanged for that event
- **AND** the HTTP status is success, not conflict

#### Scenario: duplicates do not block new events in the same batch

- **WHEN** a batch contains one duplicate and two new events
- **THEN** the two new events append
- **AND** the duplicate is reported without failing the batch

### Requirement: ingest rejects malformed events individually, not wholesale

A batch SHALL NOT be rejected as a whole when some events fail validation. Each event SHALL be validated independently; malformed events SHALL be listed in the response with a stable machine-readable rejection token and the offending path, and well-formed events in the same batch SHALL still append. An event whose `event_schema_version` exceeds the version the service supports SHALL be rejected with a version-mismatch token rather than silently interpreted.

#### Scenario: a malformed event is rejected, its siblings are accepted

- **WHEN** a batch of three events contains one with an undeclared envelope field
- **THEN** the two well-formed events append
- **AND** the response lists the malformed one with a stable token and the offending path

#### Scenario: an unsupported schema version is rejected explicitly

- **WHEN** an event carries `event_schema_version` greater than the service supports
- **THEN** that event is rejected with a version-mismatch token
- **AND** no field of the unsupported event is interpreted

### Requirement: ingest verifies payload integrity when enabled

When server-side payload verification is enabled for a project, the service SHALL compute the hash of each event's payload and compare it to the `payload_hash` the client claims. A mismatch SHALL reject that event with an integrity-violation token; the batch otherwise proceeds. The verification is per event, never per batch.

#### Scenario: a tampered payload is rejected, the rest of the batch proceeds

- **WHEN** payload verification is enabled and one event's claimed hash does not match its payload
- **THEN** that event is rejected with an integrity-violation token
- **AND** the other events in the batch append normally

### Requirement: ingest negotiates contract versions

The request SHALL carry `contract_version` and each event its `event_schema_version`. The service SHALL reject a request whose `contract_version` it does not support, and SHALL report the versions it accepted in the response. Unsupported versions never cause partial silent interpretation.

#### Scenario: an unsupported contract version is refused before any append

- **WHEN** a request declares a `contract_version` the service does not support
- **THEN** the service refuses the request without appending any event
- **AND** the response names the versions the service supports

### Requirement: query endpoints return three time-planes without truncation

`get_project_state` SHALL return the project's full three time-planes projection (History summary, Current State, Intended Direction), assembled by replaying the event ledger. `load_context` SHALL return a paginated, type- and time-filtered slice of history with opaque cursors. `search_projects` SHALL list projects the caller's device may read. Responses SHALL NOT truncate or summarize away structure to fit a length budget; the caller decides what to consume.

#### Scenario: current state reflects replayed history

- **WHEN** a project has events across boundary updates, holds, and acceptances
- **THEN** `get_project_state` returns a projection whose Current State equals a full replay of the same ledger
- **AND** the response carries the current `state_version`

#### Scenario: history loads with a cursor

- **WHEN** the client calls `load_context` with a type filter and a page size
- **THEN** the response contains only events of the requested type
- **AND** when more events match, the response carries a `next_cursor` that fetches the next page without overlap

### Requirement: authentication establishes device identity; authorization is membership

Every protected endpoint SHALL require a device API key. The service SHALL authenticate the key, resolve its participant and device, and authorize the operation against the project membership table; deny is the default. Authentication SHALL support OAuth 2.0 device authorization flow (RFC 8628): the client requests a device code, the user authorizes at a browser, the client exchanges for a session token, and registering a device issues a long-lived device API key. Revoking a device SHALL invalidate its key immediately.

#### Scenario: a valid device key is accepted

- **WHEN** a request carries a device API key for a participant who is a member of the project
- **THEN** the request is processed

#### Scenario: a non-member device key is denied

- **WHEN** a request carries a device API key for a participant who is not a member of the project
- **THEN** the request is denied with an authorization token
- **AND** no event is appended

#### Scenario: a revoked device key stops working immediately

- **WHEN** a device is revoked and the client then posts with that device's key
- **THEN** authentication fails with a device-revoked token
- **AND** no data is accepted from that device

#### Scenario: the device flow issues a device key

- **WHEN** the client completes the device flow and registers a device
- **THEN** the service issues a device API key bound to the participant and device
- **AND** the key is returned once and never logged in plaintext

### Requirement: binding is local and driven by server-verified toml declaration

The daemon SHALL maintain a local binding table mapping a repository directory to a project. A `navis.toml` in the repository root declares `project_id` (and optionally `remote`; when omitted, the daemon SHALL resolve the instance URL from the operator's global `$HOME/.navis/config.toml` and SHALL refuse to upload without any resolved remote); the toml is a declaration and never a trust basis — binding SHALL require server verification that the project exists and the device's participant is a member. Verification passing, the daemon SHALL bind automatically with no prompt; verification failing, it SHALL NOT bind and the session SHALL report the reason. The binding table SHALL stay local and SHALL never be uploaded. The daemon SHALL record a `toml_fingerprint` and detect tamper by comparing fingerprints.

#### Scenario: a toml in the root binds automatically after server verification

- **WHEN** a session starts in a directory whose root `navis.toml` declares a project the participant may access
- **THEN** the daemon binds the directory to the project without prompting the user
- **AND** the binding table records the project id, mapping id, and toml fingerprint

#### Scenario: a toml for an inaccessible project does not bind

- **WHEN** a session starts in a directory whose toml declares a project the participant may not access
- **THEN** no binding is created
- **AND** the session reports that verification failed and gives the reason

#### Scenario: binding never leaves the machine

- **WHEN** the binding table is inspected for upload behavior
- **THEN** no field of the binding table is transmitted to the server except the ids the server itself issued

### Requirement: the Outbox buffers offline and uploads only what is pending

The daemon SHALL capture session events into a local Outbox over SQLite in WAL mode. Events SHALL traverse `captured→normalized→pending→sending→acked`; `local_only` and `quarantined` are terminal states that are retained, not deleted, and are removable only by explicit pruning policy. `seq` SHALL be assigned to pending events only; events destined to stay local carry a null `seq` so they never open a gap in the server-side sequence. The upload loop SHALL take only `pending` events in bounded batches, and SHALL delete a record only after the server acknowledges the batch. Offline or failed sends SHALL retain the events and retry with bounded backoff.

#### Scenario: a local-only event carries no seq

- **WHEN** the binding privacy class is `local-only` and an event is captured
- **THEN** the record enters the `local_only` terminal state
- **AND** its `seq` is null

#### Scenario: an event is deleted only after acknowledgment

- **WHEN** a batch is sent and the server acknowledges it
- **THEN** those records are removed from the Outbox
- **AND WHEN** the server does not acknowledge
- **THEN** the records remain pending and are retried

#### Scenario: a crash mid-send leaves a consistent Outbox

- **WHEN** the daemon is killed with SIGKILL mid-upload
- **THEN** after restart the Outbox is readable and consistent
- **AND** no event is lost and no event is duplicated on resume

### Requirement: session-internal events are extracted with content protected by default

The daemon SHALL extract session process into Canonical Work Events: `user.message`, `agent.message`, `tool.call.requested`, `tool.call.result`. Under the default `metadata` privacy class, only lengths, hashes, and bounded summaries SHALL be uploaded — message bodies, tool parameters, and tool results SHALL NOT leave the machine. Events SHALL carry `causation_id` linking each event to its predecessor so session order is recoverable by replay.

#### Scenario: a metadata-class session transmits no content

- **WHEN** a user message and a tool call occur in a `metadata`-class binding
- **THEN** the uploaded events carry hashes and lengths
- **AND** the message body and tool parameters are absent from the payload

#### Scenario: session order is recoverable from causation

- **WHEN** a session produces a message, a tool call, and a tool result
- **THEN** each event's `causation_id` references the event that preceded it
- **AND** replaying the ledger in the stored order reproduces the session sequence

### Requirement: context loading is driven by state version, not session count

The session-start hook result SHALL carry a structured context summary (project name, status, `state_version`, active work count, open hold count, last update) with **no character cap**. The daemon SHALL record the `state_version` it last loaded; when a new session finds the version unchanged it SHALL inject a no-change marker instead of re-injecting the same summary. `session.resumed` and idempotent `reused` hook results SHALL NOT re-inject context. When the network is unavailable, the query path SHALL return the local cache marked stale with its cache timestamp.

#### Scenario: an unchanged project injects a no-change marker

- **WHEN** a session starts and the project's `state_version` equals the last loaded version
- **THEN** the hook result carries a no-change marker
- **AND** the structured summary is served from cache

#### Scenario: an advanced version injects a fresh summary

- **WHEN** a session starts and the project's `state_version` advanced since the last load
- **THEN** the hook result carries the fresh structured summary
- **AND** the daemon records the new version as last loaded

#### Scenario: offline loading is marked stale

- **WHEN** the network is unreachable at session start
- **THEN** the hook result carries the cached summary
- **AND** the result marks it stale with the cache timestamp

### Requirement: the daemon runs one instance per user with cross-platform parity

The daemon SHALL run as a single instance per user; a second connect SHALL NOT spawn a second process. IPC SHALL use a Unix domain socket on macOS and Linux and a named pipe on Windows; credentials SHALL be stored in the OS keychain (Keychain / Credential Manager / libsecret). Functional behavior SHALL be identical across the three platforms; the only differences are the transport and storage adapters.

#### Scenario: a second connect reuses the running daemon

- **WHEN** a client connects while the daemon is already running
- **THEN** the connect reuses the existing process
- **AND** no second daemon is spawned

#### Scenario: Windows uses a named pipe with identical behavior

- **WHEN** the daemon runs on Windows
- **THEN** IPC uses a named pipe
- **AND** binding, capture, and upload behave the same as on macOS and Linux
