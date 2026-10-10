# Foundation readiness

Reviewed on 2026-10-10 for the service integrity correction. Readiness requires evidence from the real consumer; a module, an archived task or a proposed ADR alone does not complete a foundation. Module ownership is recorded in [architecture](architecture.md).

| Foundation                                       | Observed state                                                                                                                      | Required before                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Runtime and package-manager pinning              | Package and CI pin Node 24.19.0 / pnpm 11.22.0; verify runtime-manager selection                                                    | Reproducible contributor and CI execution |
| Format, lint, type, test, build and import gates | Present; the API composition root has a precise adapter-import boundary                                                             | Implementation submission                 |
| Public JSON, pagination, errors and correlation  | Schemas and HTTP adapter implemented                                                                                                | Cross-consumer conformance                |
| Contract schema authority                        | Public schemas implemented; Bridge producer/consumer mismatch remains                                                               | Complete local synchronization            |
| Domain ownership and immutability                | Kernel implemented; asset/effect read results are owned immutable copies                                                            | Trustworthy read and mutation boundaries  |
| Application command and transaction boundary     | Injected dispatch and PostgreSQL transaction wrapper implemented; public business-command mapping absent                            | Durable public command execution          |
| API configuration and startup                    | Validated configuration, thin process entry and adapter composition implemented                                                     | Accepted service composition              |
| Logs, errors and traces                          | Modules and tests present; operating evidence remains outstanding                                                                   | Production service operation              |
| Authentication and authorization                 | Device flow, ingest membership/device guards and participant-owned revocation implemented; browser authorization remains incomplete | Protected end-to-end workflow             |
| Persistence and migrations                       | EventStore, snapshots and SQL migrations implemented; persisted observations validate in full and snapshot replay                   | Reliable ingest-to-query and restore      |
| Local durability and packaging                   | SQLite modules implemented; built migration assets and runtime recovery composition incomplete                                      | Installed Bridge operation                |
| Retry, cancellation and effects                  | Kernel states and upload tick implemented; executing-effect gate and end-to-end recovery need review                                | External effect execution                 |
| Health and shutdown                              | HTTP liveness, shutdown and pool cleanup implemented; dependency readiness remains incomplete                                       | Deployable service acceptance             |
| Backup, disaster recovery and retention          | No deployment restore or recovery evidence                                                                                          | Production deployment                     |
| Browser interaction and accessibility            | Web workflow and runtime not admitted                                                                                               | First human review workflow               |
| Artifact provenance and rollback                 | Local build-mount Compose only; no immutable release artifact                                                                       | Release promotion                         |

All ten ADRs still carry their recorded `Proposed` status. This register does not promote them or rewrite the historical review outcome. Confirm the decision record and the implemented behavior separately.

Use an explicitly identified disposable database for real-engine verification. Integration suites normalize blank database values to unconfigured; API startup rejects a supplied invalid URL. Direct driver construction still requires a validated connection string.

## Current verification

The 2026-10-10 local `pnpm validate` run passed all seven gates against a disposable PostgreSQL 15 database: 81 test files, 1,189 passed tests, zero skipped. Statement, line and function coverage were 100%; branch coverage was 96.34%. The dependency scan covered 440 modules and 803 dependencies.

This verifies the implemented slice. The incomplete CLI/daemon integration, browser authorization, current-state read model, executing-effect delivery policy and release operations remain outstanding as listed above.

## Submission review

The reproduced observation, producer and revocation failures are corrected in `service-integrity-hardening`:

- Contracts owns strict payload validation, including nested session privacy fields. Tolerant consumers retain additive compatibility.
- Application supplies that validator to Domain replay. Missing validation, malformed payloads and unknown event types fail closed; a snapshot cannot hide invalid observations.
- Application authorizes revocation against target ownership. Installed-route tests prove foreign and missing targets receive the same 403 without changing device/key records. Invalid device-management credentials receive 401; owner revocation still invalidates the key immediately.

The built API returned 200 for health and device-code creation, 401 for unauthenticated device management, and exited with code 0 after SIGTERM. Compose configuration validated. The PostgreSQL CI gate now checks the JSON report from the actual database run; its guard rejects skipped, failed and incomplete reports.

`pnpm dependencies:audit` could not complete on 2026-10-10 because the npm registry repeatedly reset the connection. This is an outstanding external check, not a clean vulnerability result; rerun it in CI before merge or release. No new external dependency is introduced by this correction. The full product and operational gaps above remain separate acceptance work.
