# Engineering standards index

These standards define how production code is designed, implemented, verified, released, and operated. They do not define product behavior. Observable requirements belong in OpenSpec; material technology choices belong in ADRs.

## Required reading matrix

Every implementation task reads this index and `01-source-code.md`. Read the additional standards selected by the change:

| Change type                                                        | Required standards                    |
| ------------------------------------------------------------------ | ------------------------------------- |
| Tests or behavior                                                  | `02-testing.md`                       |
| Errors, logs, metrics, traces, or audit                            | `03-errors-and-observability.md`      |
| Identity, authorization, input, secrets, or personal data          | `04-security.md`                      |
| Documentation or public exports                                    | `05-documentation.md`                 |
| HTTP, events, public schemas, or compatibility                     | `06-contracts-and-compatibility.md`   |
| Database, cache, object storage, retention, or migration           | `07-data-and-persistence.md`          |
| Retries, queues, concurrency, idempotency, or background work      | `08-concurrency-and-reliability.md`   |
| Dependency, build plugin, generated code, or package               | `09-dependencies-and-supply-chain.md` |
| Latency, throughput, memory, CPU, payload size, or load            | `10-performance-and-resources.md`     |
| CI, artifact, deployment, versioning, or release                   | `11-ci-and-release.md`                |
| Service process, configuration, health, SLO, incident, or recovery | `12-operations.md`                    |
| Browser UI or design-system code                                   | `13-user-interface.md`                |

OpenSpec proposals and designs list the standards selected by this matrix. Implementation tasks name the verification that proves compliance.

## Production-grade meaning

These documents are a production engineering baseline, not proof that an implementation is production-ready. A component may claim production readiness only when applicable rules are enforced and supported by test, migration, security, performance, recovery, release, and operational evidence.

An exception states its owner, scope, reason, risk, compensating control, expiry date, and removal issue. Permanent undocumented exceptions are not allowed.
