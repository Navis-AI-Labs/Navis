# Tasks

- [x] Review accepted requirements, source ownership, standards 01–12, affected ADRs, pending diff and commit history; reproduce the three integrity/authorization defects.
- [x] Contracts: enforce `work-contracts` nested strictness and single-schema payload parsing; verify `work-event.test.ts`.
- [x] Domain and Application: enforce validated observation replay under `project-state-kernel`; verify `state-kernel.test.ts`, `project-query.test.ts` and `ingest-batch.test.ts`.
- [x] Application and API: enforce participant-owned revocation under `bridge-remote-sync`; verify `device-auth-flow.test.ts`, `device-auth.test.ts` and installed-route `auth-middleware.test.ts`.
- [x] API, CLI and Infrastructure: verify accepted service composition, public-view isolation, command module ownership and real-engine fixture isolation with build, boundaries and adapter tests.
- [x] Complete full `pnpm validate` on disposable PostgreSQL with zero skips, record the dependency-audit outcome, verify Compose and built API startup/shutdown, update existing documentation, and archive the accepted scenarios.

## Evidence

- Node 24.19.0 / pnpm 11.22.0: `pnpm validate` passed against disposable PostgreSQL 15; 81 test files, 1,189 passed, zero skipped. Statements, lines and functions 100%; branches 96.34%. Dependency graph: 440 modules / 803 edges, no violations.
- Focused repair suite: 199 passed. PostgreSQL device-auth adapter suite: 22 passed, zero skipped. The CI JSON-report guard accepted that report and rejected skipped, failed and incomplete reports.
- Built API with PostgreSQL: health 200, device-code creation 200, unauthenticated device management 401, SIGTERM exit 0. `docker compose config --quiet` passed.
- `pnpm dependencies:audit` was attempted but npm registry connections reset after retries. Vulnerability status remains unverified; CI must rerun this check before merge or release. No new external dependency was added.

All behavior corrections are covered by the accepted scenarios. Remaining client integration, full read models, browser authorization, ADR acceptance and release evidence are tracked in the existing architecture/readiness documents.
