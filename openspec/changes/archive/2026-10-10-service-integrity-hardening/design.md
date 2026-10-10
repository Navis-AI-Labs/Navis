# Design

## Ownership

Contracts constructs strict and tolerant nested payloads from the same field shapes. A strict payload parser selects a variant from the existing Canonical Work Event union; it does not declare a second vocabulary or schema.

Domain accepts a synchronous, deterministic observation validator at replay entry. It rejects non-kernel events when no validator is supplied. The kernel retains the validator for later replay and integrity checks; snapshot-covered history is also validated. Observations advance sequence and causal authorship but cannot enact commands or change business state. Application supplies the Contracts parser. Domain importing Contracts or duplicating its event schema would violate schema authority and dependency direction.

Device revocation loads the target through the existing port and returns denial for missing or foreign-owned devices before mutation. Device ownership is immutable in the admitted port; no ownership-transfer race exists. API maps denial to the existing 403 problem and missing, invalid or revoked credentials to 401. No administration policy is inferred. A repeated owner revocation remains successful.

## Existing worktree integration

API adapter imports move from a broad platform entry to the exact `platform/composition.ts` boundary. `platform/routes.ts` installs request-local identity and membership guards; `platform/index.ts` only starts and stops the runtime. CLI invocation leaves its export barrel. Asset/effect views return immutable owned data. Event and snapshot constants remain with their capability owner. Ingest uses the committed ledger version, independent of snapshot age. The PostgreSQL CI lane checks the machine-readable report from its one real-engine run rather than rerunning tests without a database environment. Local Compose publishes only loopback ports.

## Compatibility and risk

Clean version-1 events retain their representation. Strict producers now reject invalid fields they previously discarded; tolerant consumers still strip additions. Replay callers with observations must explicitly supply validation; kernel-only callers are unchanged. Device-management clients receive 401/403 instead of misleading successful empty/false responses. Invalid historical observations fail replay; this change does not silently rewrite persisted data.

## Verification

Selected standards: `01-source-code.md`, `02-testing.md`, `03-errors-and-observability.md`, `04-security.md`, `05-documentation.md`, `06-contracts-and-compatibility.md`, `07-data-and-persistence.md`, `08-concurrency-and-reliability.md`, `09-dependencies-and-supply-chain.md`, `10-performance-and-resources.md`, `11-ci-and-release.md`, `12-operations.md`.

Focused regressions cover nested producer/consumer behavior, missing validators, malformed and unknown observations, full and snapshot replay, foreign/missing targets, and unchanged target keys after denial through the installed routes. Existing adapter contracts run against a disposable PostgreSQL 15 database. Full `pnpm validate`, local Compose configuration and built-process startup/shutdown provide submission evidence. The production dependency audit is attempted separately; an unavailable registry is recorded as an outstanding external check, never a clean result. Boundary validation enforces the exact adapter import exception. No production readiness is inferred from these checks.
