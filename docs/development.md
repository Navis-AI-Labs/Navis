# Development workflow

## Document and code ownership

| Question                                           | Location                                      |
| -------------------------------------------------- | --------------------------------------------- |
| What Navis is                                      | Root `README.md`                              |
| What behavior must be observable                   | OpenSpec requirements and scenarios           |
| How a change moves from proposal to implementation | Active OpenSpec change                        |
| Which boundary owns a responsibility               | `docs/architecture.md`                        |
| Why a technical choice was made                    | `docs/adr/`                                   |
| How production code must be engineered             | `docs/standards/`                             |
| Which foundations are ready                        | `docs/foundation-readiness.md`                |
| What behavior actually runs                        | Source and tests in activated workspace units |

Code directories do not carry placeholder README files. A package manifest, explicit exports, tests, and generated contract artifacts document an activated code boundary; the architecture document records planned boundaries.

## Verification environment

Use Node.js 24.19.0 and pnpm 11.22.0 from `package.json` and CI. Package metadata and CI define the required versions. Check the executable selected by a runtime-manager shim before validation. Check both Node and pnpm versions before validation.

For a run without PostgreSQL, remove `DATABASE_URL` from the test process environment. Integration suites treat an empty or whitespace-only value as unconfigured, while API startup rejects a supplied invalid database URL. A real PostgreSQL run requires an explicitly identified disposable test database; the suites apply migrations and leave test rows behind. Do not pass an empty connection string directly to the driver, which can select a default local database.

Tests and coverage measure their selected sources. A process-entry smoke test, a built-package installation check, and a client-to-service contract test are separate evidence. Preserve a running checkout's build artifacts when investigating which version it executed.

## Local API and PostgreSQL

After installing the pinned dependencies, run `pnpm build`, then `docker compose up -d`. The API mounts this checkout and uses its built files; it is reachable at `http://127.0.0.1:8080`, with PostgreSQL on loopback port 55432. Rebuild and restart the API after changing source. The local Compose image uses the Node 24 major tag; release artifacts and exact runtime provenance remain separate work.

The Compose database is disposable development data. No named persistent volume is configured; `docker compose down --volumes` removes its attached anonymous storage. Do not use it for shared or authoritative data. Validation should use its own disposable database, independent of a running development stack.

## OpenSpec flow

1. Create or update a change under `openspec/changes/<change-id>/`.
2. Define the problem and non-goals in `proposal.md`.
3. Define observable requirements in `specs/<capability>/spec.md`.
4. Explain ownership, alternatives, selected standards, and unresolved decisions in `design.md`.
5. List ordered work and verification in `tasks.md`.
6. Obtain review before business implementation.
7. Implement only the accepted scope and keep task status current.
8. Validate, review, move accepted behavior to root specs, and archive the change.

OpenSpec does not store coding style or generic production practice. Its context file routes contributors to `docs/standards/00-index.md`, and each design names the standards that apply.

## Activating a workspace unit

Before creating a package, application, or service, the active change must identify:

1. accepted executable responsibility;
2. concrete consumers;
3. allowed and forbidden dependencies;
4. public exports or process entry points;
5. build and test boundaries;
6. ownership, deployment, publication, or trust reason;
7. applicable standards and verification;
8. accepted ADRs for material technology.

Only the workspace-unit root owns `package.json` and `tsconfig.json`. Internal capability directories own neither.

## Foundation-first rule

Before business code enters an activated boundary, complete the applicable rows in `docs/foundation-readiness.md`. For example, a service cannot add a business handler before configuration validation, public error mapping, telemetry, graceful shutdown, health checks, and service tests exist for the selected runtime.

This rule does not justify unused framework packages. A foundation is built with its first real consumer, then reused when a second consumer proves a stable shared boundary.

## Review evidence

Every implementation change reports:

- accepted OpenSpec requirements implemented;
- ADRs applied or added;
- standards selected from the matrix;
- affected dependency graph;
- commands run and results;
- generated artifacts changed;
- compatibility and migration classification;
- residual risk and deferred foundation work.
