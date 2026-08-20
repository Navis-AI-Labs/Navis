# Testing standard

## Test strategy

- Test observable behavior at the narrowest layer that can prove it. Domain policy uses pure tests; Application orchestration uses controlled port doubles; adapters use contract and integration tests; public workflows use a small number of end-to-end tests.
- Every accepted OpenSpec scenario maps to an automated test or a documented non-automatable verification.
- Tests cover invalid input, authorization denial, stale state, duplicate delivery, timeout, cancellation, dependency failure, partial failure, and recovery where applicable.
- Property-based, fuzz, model, or state-machine tests are used when an invariant has a large input or transition space.
- Contract tests run against every implementation of a port. Storage adapters are verified against the real engine, not only an in-memory substitute.

## Determinism and isolation

- Tests do not depend on wall-clock time, random global state, execution order, shared mutable fixtures, the public network, or a developer machine.
- Time, identifiers, randomness, external services, and process signals are controlled at their owning boundary.
- Each test owns its data and cleanup. Parallel execution must not create name, port, tenant, or database collisions.
- Snapshot tests are limited to stable, reviewable contracts. Large snapshots do not replace behavioral assertions.
- Flaky tests are defects. Automatic retries may collect diagnostics but may not make an unstable required check green.

## Coverage and completion

- Coverage thresholds are risk-based and enforced per workspace unit. Changed critical policy, security, parsing, migration, and failure code covers meaningful branches.
- Mutation testing is considered for high-risk pure policy when ordinary coverage cannot demonstrate assertion quality.
- A package cannot pass because it has no tests. Test commands fail when expected tests are not discovered.
- A defect fix includes a regression test that fails without the fix.
- Test evidence includes command, environment assumptions, and result; production data and secrets are never fixtures.
