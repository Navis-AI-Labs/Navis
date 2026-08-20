# CI and release standard

## Continuous integration

- Required CI runs on a clean checkout with a frozen dependency graph and no developer-global tools.
- The baseline gate includes format, lint, type, dependency boundaries, tests, build, vulnerability checks, and documentation validation.
- CI fails on missing tests, skipped required suites, unexpected generated changes, policy warnings, or non-reproducible artifacts.
- Protected branches require successful checks and owning-boundary review. CI credentials use least privilege and short-lived identity where available.

## Artifacts and versions

- Build once and promote the same immutable artifact through environments.
- Artifacts carry source revision, dependency inventory, build environment, and integrity metadata.
- Public packages and contracts follow explicit compatibility and versioning. Internal deployment versions remain traceable.
- Release notes describe behavior, compatibility, migration, configuration, security, and operational impact.

## Deployment and rollback

- A release defines preconditions, rollout, health signals, abort thresholds, rollback or roll-forward, and data compatibility.
- Database and contract changes remain compatible across the rollout window.
- Feature flags have owner, default, scope, observability, removal condition, and safe failure. Flags are not permanent architecture.
- Production release requires security, migration, backup/restore, capacity, and runbook evidence selected by the change.
