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
