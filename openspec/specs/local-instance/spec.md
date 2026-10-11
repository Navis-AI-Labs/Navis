# local-instance Specification

## Purpose

TBD - created by archiving change local-instance-runtime. Update Purpose after archive.

## Requirements

### Requirement: local operators can provision attributable device identities

The instance SHALL provide a privileged local operator command to provision human or agent principals and device credentials. Only verifiers SHALL be persisted; credentials SHALL be returned once and kept out of telemetry. Network callers SHALL NOT choose their actor kind or invoke operator provisioning without the local operator boundary.

#### Scenario: an operator provisions an agent

- **WHEN** an operator creates an agent device through the local command
- **THEN** its credential authenticates as that agent
- **AND** requests cannot promote it to a human or execute human-only acceptance

### Requirement: projects and commands commit atomically with authorization

Project creation SHALL durably create project authority and initial membership. Every business command SHALL validate the current member's separate proposal/execution grants, actor identity and expected business version. Ledger writes, directory state and idempotency outcome SHALL commit in one transaction. Reusing a key for different identity, type or payload SHALL fail. An exception SHALL leave no partial claim or business writes.

#### Scenario: creating a project survives restart

- **WHEN** an authenticated principal creates a project and the service restarts
- **THEN** the project, membership and replayed projection remain accessible to authorized devices

#### Scenario: retry and concurrent commands preserve authority

- **WHEN** a command response is lost and the same operation is retried
- **THEN** its committed outcome is replayed without duplicating events
- **AND** a conflicting payload or unauthorized actor receives no prior result or new authority

### Requirement: complete reads expose ledger progress independently of business version

Project reads SHALL expose the complete current projection and a ledger cursor from one consistent observation. Context refresh SHALL detect ledger advancement even when the business version is unchanged. Limits SHALL fail explicitly without truncating an authoritative projection.

#### Scenario: ordinary work refreshes context

- **WHEN** work activity advances the ledger without changing project_state_version
- **THEN** a subsequent context load reports the newer cursor and current work state

#### Scenario: listed project identities can be opened and paginated

- **WHEN** an authorized caller lists its projects
- **THEN** every project identity is the persisted identity accepted by the snapshot route
- **AND** subsequent pages continue from that identity without overlap

### Requirement: installed clients preserve observations through transfer failures

The shipped CLI SHALL start or reuse a per-user Bridge process and use its credential, binding and durable Outbox authority. Binding SHALL require server-verified membership. Session observations SHALL satisfy the canonical contract and default to metadata-only upload. Receipts SHALL be validated against the exact sent batch before any deletion. Capture and sequence identity SHALL survive restart; replayed upload SHALL not duplicate server events.

#### Scenario: a captured event survives a crash and a lost response

- **WHEN** the daemon dies after durable capture or after server commit but before receipt handling
- **THEN** restart retries the same event identity
- **AND** the server commits at most one ledger event while the client retains it until confirmed

#### Scenario: a malformed or unauthorized transfer cannot erase data

- **WHEN** a response is incomplete, forged, mismatched or denied by authentication
- **THEN** no unconfirmed local event is deleted
- **AND** retries are bounded or suspended until credentials/policy are repaired

### Requirement: unresolved side effects block delivery

Delivery SHALL be refused while relevant effects are unknown or executing, including late-cancelled unresolved effects. A recorded terminal fact SHALL be required before the delivery gate can open; the service SHALL NOT execute external effects merely by recording their status.

#### Scenario: execution start cannot open the delivery gate

- **WHEN** an unresolved effect changes from unknown to executing
- **THEN** delivery remains blocked until the effect is settled according to kernel policy

### Requirement: Docker deployment is durable and verifiably recoverable

The deployment SHALL expose one Compose project with separate API and PostgreSQL service containers, built API artifacts and a persistent database volume, with private credentials, unprivileged application and database execution, loopback-only published HTTP, dependency-aware readiness and bounded graceful shutdown. Startup without its required database SHALL fail closed. Backups SHALL be restorable into an independent environment. The operator SHALL receive reproducible connection and project-creation instructions.

#### Scenario: database loss changes readiness and recovery preserves data

- **WHEN** PostgreSQL becomes unavailable
- **THEN** readiness returns 503 without exposing credentials
- **AND** recovery restores readiness and previously committed project data

#### Scenario: an independent restore recovers project authority

- **WHEN** an operator restores a backup into a fresh database
- **THEN** authenticated reads and replay recover the same committed project state and cursor

### Requirement: model assistance is configured independently and cannot accept its own output

The service SHALL keep the model endpoint, model identity and secret separate from Navis device credentials and client remote configuration. An authorized assistance request SHALL invoke the configured model with bounded resources and record its output as candidate material. Provider failures SHALL produce safe errors without revealing credentials. Model output SHALL NOT perform acceptance, delivery confirmation, shell execution or unrestricted tool calls.

#### Scenario: configured model produces a candidate

- **WHEN** an authorized project member explicitly requests assistance
- **THEN** the service calls the configured provider and returns attributable candidate material
- **AND** acceptance still requires an authorized human action

#### Scenario: provider credentials or availability fail

- **WHEN** the model service denies authentication, times out or returns an invalid response
- **THEN** the operation reports a bounded safe failure and no accepted project fact is created

### Requirement: Compose manages separate service lifetimes

The instance SHALL declare separate API and PostgreSQL services in one Compose project. API startup SHALL wait for database health. Each service SHALL have bounded shutdown and a process restart policy. Recreating the API SHALL NOT recreate or erase the database volume. The database SHALL NOT have a published host port.

#### Scenario: the database is unavailable

- **WHEN** PostgreSQL stops while the API is running
- **THEN** API readiness fails and the API process remains observable
- **AND** after database recovery, authenticated reads recover the committed state

#### Scenario: the API is recreated

- **WHEN** the API container is replaced
- **THEN** the separate database service and committed project state are preserved

#### Scenario: the runtime artifact leaves the build workspace

- **WHEN** the built API package is placed in its runtime image
- **THEN** its dependencies and package self-reference resolve entirely inside the runtime artifact
- **AND** it does not require the original source or build directory

### Requirement: routine health probes do not flood operational logs

Successful liveness and readiness requests SHALL be logged at debug level. Failed probes SHALL remain visible at the configured operational log level and preserve their status and correlation. Ordinary successful business requests SHALL retain normal request logging.

#### Scenario: healthy probe at the default log level

- **WHEN** a health or readiness request succeeds while logging is configured at info level
- **THEN** it returns its successful response without an info access-log entry

#### Scenario: readiness fails because the database is unavailable

- **WHEN** the database readiness check fails
- **THEN** the response is 503 and a correlated failure is logged

### Requirement: native clients and setup are portable across supported hosts

The same source distribution SHALL support setup and native CLI/Bridge operation on Windows, macOS and Linux with the documented Node and Docker prerequisites. Installation SHALL generate host-appropriate launchers without requiring a Unix shell on Windows. Separate credential profiles SHALL use distinct IPC endpoints. Secrets and local state SHALL remain private under the host's native access-control model. Repository files SHALL NOT contain a developer's personal paths, credentials or instance inventory.

#### Scenario: two profiles on one Windows account

- **WHEN** human and agent clients use different profile directories under the same operating-system account
- **THEN** they start separate daemon endpoints and retain separate credentials and Outbox state

#### Scenario: a contributor checks source before building packages

- **WHEN** generated workspace declarations are absent or older than the source
- **THEN** type-aware source linting resolves the current workspace source exports without treating valid imports as error-typed values

#### Scenario: installation on another supported host

- **WHEN** a user installs the client in a directory containing spaces on a supported host
- **THEN** its native launcher reaches the installed CLI and preserves arguments and explicitly selected profiles
- **AND** credentials and private state remain restricted to the operating-system user and privileged system administrators

#### Scenario: rebuilding source does not mutate an installed client

- **WHEN** a contributor rebuilds the source workspace after installing the client
- **THEN** the installed client keeps a complete, unchanged runtime until an explicit reinstall
- **AND** its dependencies do not require files outside the installed package directory

#### Scenario: Windows paths and JSON contain non-ASCII text

- **WHEN** an installation or input path contains non-ASCII characters and a command file uses UTF-8 with a BOM
- **THEN** the generated Windows launcher reaches the installed Node executable without depending on the CMD source code page
- **AND** CLI parsing preserves the command content and applies the same request validation

### Requirement: an optional agent skill uses the installed client boundary

The distribution SHALL provide an optional skill with project binding, context, Equip, Return and capture guidance. Installation SHALL target an explicitly selected directory and keep the machine's executable paths only in that installed copy. The skill SHALL preserve device identity, project authorization and human-only decisions. Installing it SHALL NOT change external tool hook settings or introduce another service.

#### Scenario: another project starts a Navis session

- **WHEN** an Agent loads the installed skill in a consuming project
- **THEN** it can invoke the installed CLI to check the connection and verified project binding
- **AND** missing membership or human approval is reported without selecting a human credential or inventing authority

### Requirement: operational logs remain bounded and separate from authority

The runtime SHALL send operational logs to its standard output/error streams for container collection with bounded retention. It SHALL retain safe lifecycle and failure summaries while excluding credentials, full SQL statements, bound parameter dumps and failing-row detail from default database logging. Business authority and audit records SHALL remain in their authoritative stores independently of operational log rotation.

#### Scenario: API lifecycle logging

- **WHEN** the API starts, stops, or fails to start
- **THEN** it emits a structured lifecycle outcome without configuration values, credentials or dependency error payloads

#### Scenario: a database constraint rejects sensitive content

- **WHEN** a database operation fails on a constraint involving a protected payload
- **THEN** the operator can observe the failure summary
- **AND** the default server log omits the SQL statement, parameters and failing-row detail
