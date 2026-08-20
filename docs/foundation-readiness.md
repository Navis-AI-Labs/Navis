# Foundation readiness

Production foundations are completed before business code in their first real consumer. This register prevents both premature package creation and feature work on an unsafe base.

| Foundation                                                 | Current state                         | Required before             |
| ---------------------------------------------------------- | ------------------------------------- | --------------------------- |
| Runtime and package-manager pinning                        | Foundation candidate                  | Any workspace build         |
| Format, lint, type, test, build, and dependency gates      | Foundation candidate                  | Any source contribution     |
| JSON success, pagination, error, trace, and schema profile | Foundation candidate                  | Any HTTP behavior           |
| Contract schema authority and type safety                  | Foundation candidate                  | Any public contract release |
| Domain purity and import gate                              | Architecture only                     | First Domain behavior       |
| Application port and transaction conventions               | Architecture only                     | First use case              |
| Configuration loading and startup validation               | Deferred to runtime ADR               | First service process       |
| Structured logs, metrics, tracing, and redaction           | Deferred to runtime ADR               | First service process       |
| Authentication and authorization enforcement               | Deferred to identity ADR and OpenSpec | First protected operation   |
| Persistence, migrations, backup, restore, and deletion     | Deferred to persistence ADR           | First durable record        |
| Queue, idempotency, retry, cancellation, and recovery      | Deferred to Worker ADR                | First asynchronous effect   |
| Health, shutdown, SLO, alert, and runbook                  | Deferred to deployment ADR            | First deployable service    |
| Accessibility, UI error states, and Web budgets            | Deferred to Web ADR                   | First user workflow         |
| Artifact provenance, promotion, and rollback               | Specified; automation deferred        | First deployable artifact   |

`Foundation candidate` means implemented for maintainer review but not yet accepted as a permanent project decision. `Deferred` means there is no selected runtime or consumer; the applicable production standard becomes mandatory when that boundary is activated.

No row becomes ready because a document exists. Readiness requires automated, compatibility, security, performance, migration, recovery, release, or operational evidence selected by `docs/standards/00-index.md`.
