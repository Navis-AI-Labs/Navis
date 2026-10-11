# Tasks

- [x] Inspect current code, accepted requirements, standards 01–12, relevant decisions, Docker containers and stored data; define the local-instance acceptance boundary.
- [x] Contracts/Domain: define project requests, capability evaluation, projection/cursor responses and corrected effect-delivery gates; verify contract and kernel policy tests.
- [x] Application/Infrastructure: implement operator provisioning, atomic project creation/membership/commands and bounded reads; verify real PostgreSQL transaction, concurrency and authorization tests.
- [x] API: install project operations, safe errors, required database configuration, dependency readiness and bounded HTTP lifecycle; verify real listeners and process startup/shutdown.
- [x] Bridge: implement contract-correct extraction/transport, durable retry/receipt handling, monotone sequence and recovery; verify real SQLite and API integration.
- [x] CLI/Bridge: implement installed executable, independent daemon startup, bounded IPC, credential/binding/project commands and context refresh; verify actual child processes and packaged SQL assets.
- [x] Model integration: configure the supplied provider as a server-side secret, implement bounded candidate-only assistance, and verify a small real request plus timeout/authentication failure tests.
- [x] Operations: build reproducible image, private credentials, persistent Compose deployment and backup/restore procedure; preserve existing data and verify disposable Docker environment first.
- [x] Run complete validation with real PostgreSQL, zero skips, dependency audit and failure-injection workflow; fix every observed blocker and record unresolved limits explicitly.
- [x] Leave the verified Docker environment running, update existing documentation/status and provide exact connection/project-creation/experiment instructions without exposing credentials.

- [x] Run API and PostgreSQL as separate services in one Compose project; preserve the existing data volume and verify startup, dependency outage, restart, recreation and backup restoration.
- [x] Remove machine-specific inventories, generated IDs and individual test-run reports from repository documents; retain portable configuration, supported databases and usage guidance.
- [x] Recheck the named source files with compiler and language-service diagnostics; validate the final source and leave only the requested instance.

- [x] Reproduce and fix error-typed lint diagnostics without generated workspace declarations; retain strict unsafe-value rules.
- [x] Implement native Windows launchers, shell-free package-manager invocation, private ACLs and profile-isolated IPC; verify host-independent installation and runtime tests.
- [x] Configure native client/setup tests in the Windows, macOS and Linux CI matrix, verify native macOS/Linux paths, retain the Compose deployment and update portable usage documentation without machine-specific records.
- [x] CLI/installer (standards 01, 02, 04, 05, 11): review Windows launch, ACL, IPC and recovery semantics, fix non-ASCII paths and UTF-8 BOM input; verify script and CLI regressions. Local submission accepts this review and portable evidence; an observed native Windows CI run remains a prerequisite for a tested cross-platform release claim.
- [x] Agent onboarding (standards 01, 02, 04, 05): ship and install the optional CLI skill into explicitly selected skill directories; verify installation and installed-client invocation from another directory without changing external hook settings.

- [x] Log successful health/readiness requests at debug level, retain failures, and verify Docker probe timing and real log output.
- [x] Correct project-directory SQL alias mapping and verify real database list-to-snapshot and pagination behavior.

- [x] Verify generated Compose naming and bounded log collection; retain safe API lifecycle outcomes and reject sensitive database log detail with real-engine tests.

- [x] API/CLI packaging (standards 01, 02, 09, 11): share artifact isolation, verify package self-references and inspect the built image for external or broken dependency links.
