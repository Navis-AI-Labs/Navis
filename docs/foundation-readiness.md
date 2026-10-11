# Foundation readiness

This register describes implemented boundaries and the evidence required before submission or release. It contains no machine inventory, instance identifiers or individual test-run report. Architecture is defined in [architecture](architecture.md); setup and operation are documented in [development](development.md).

## Implemented boundaries and required checks

| Boundary                | Implemented control                                                                        | Required verification                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Source and dependencies | Strict TypeScript, explicit exports, inward dependencies and pinned tooling                | `pnpm validate` and `pnpm dependencies:audit`                                             |
| Command authority       | Persisted proposal/execution grants, human-only decisions and idempotent commands          | Application and API authorization, concurrency and transaction suites                     |
| Read model              | Complete projection and independent ledger cursor from one bounded observation             | Query, snapshot, replay and capacity suites                                               |
| Authentication          | Attributable device credentials, verifier-only key storage and owner-scoped revocation     | Device-flow, concurrent exchange/registration and HTTP isolation suites                   |
| Bridge                  | Private configuration, SQLite durability, canonical capture and validated acknowledgments  | Real SQLite, IPC, installed-process and remote receipt suites                             |
| Model assistance        | Explicit authorized requests, finite retries/budgets and candidate-only results            | Provider failure tests plus an operator-authorized real-provider check                    |
| Database                | PostgreSQL server adapter and schema baseline; separate SQLite client persistence          | Real-engine constraints, rollback, concurrency and recovery suites                        |
| Container lifetime      | Separate Compose services; dependency-aware API startup and independent process lifetimes  | Actual container startup, database-outage and API-recreation checks                       |
| Deployment state        | Read-only root filesystem, private secret copies, persistent data volume and loopback HTTP | Fresh initialization, process identity, mounted storage and listener checks               |
| Recovery                | Encrypted backups and isolated restoration using the same runtime                          | Backup authentication, restored credential acceptance and full projection/cursor equality |

Repository validation requires an explicitly designated disposable PostgreSQL database and no skipped required suites. Compiler, language-service and package installation checks cover different consumers; one is not evidence that another has run. Test and release systems retain their artifacts separately from product documentation.

## Logging boundary

The local profile keeps Compose-generated names and uses bounded, compressed Docker log retention. Safe lifecycle/request/failure records remain observable; successful probes are debug-only. PostgreSQL statement, parameter and failing-row detail logging is disabled by default. Business audit is stored independently. This establishes local operational diagnostics, not durable centralized log retention or alert delivery; those remain release gates for broader production operation.

## Supported use and remaining release work

The headless interface provides project creation and membership, Work, Equip, Return, human acceptance, effect facts, delivery confirmation, explicit session capture and model candidates. Other projects consume the API or installed CLI and do not need to use the same database engine as Navis.

Docker Compose manages separate API and PostgreSQL containers in one project. The API waits for initial database readiness, reports later dependency failures and reconnects after recovery. Model assistance runs within the API, and the native Bridge runs on the client host. Persistent storage survives container recreation. This packaging does not provide multi-host availability.

Browser approval/UI, automatic adapters for every coding runtime, encrypted raw-transcript transport, public TLS deployment, multi-host recovery, monitoring/alerting and release promotion require their own accepted scope and evidence. A test pass does not establish those capabilities. Historical proposed ADRs retain their statuses; ADR-0013 owns the current instance packaging decision.

## Host verification

CI must exercise native setup, launcher argument handling, private-file rejection, profile isolation and daemon restart on Windows, macOS and Linux. Platform simulation can test path construction, but does not replace the native-host run. The server services run as Linux containers on all supported hosts. Source lint also has a no-generated-declaration regression test that proves valid workspace imports resolve while genuinely unsafe assignments remain rejected.

Local-instance submission accepts Windows implementation review and portable regression evidence for launchers, non-ASCII paths, BOM input, ACL policy, profile-scoped IPC and process recovery. This scope does not claim observed native Windows execution. The three-host native CI matrix remains a prerequisite for advertising a tested cross-platform release; Linux Docker execution proves only the Linux runtime.

The optional Navis skill uses the installed CLI and preserves the existing identity and authority boundaries. Its installer verifies that a client exists and keeps generated machine paths outside the repository. Installed-client invocation from another directory is verified separately from source-level tests.
