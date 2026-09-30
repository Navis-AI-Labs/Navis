# Design: bridge-remote-sync-ingest

## Context recap

This change turns the closed Bridge research record into the first runnable two-sided Navis. The domain kernel, contracts, and infrastructure already exist; this change wires accepted behavior to a service and a local daemon. No domain behavior changes.

## Ownership and dependency direction

```
                 apps/web (future, not this change)
                     │ consumes public contracts only
services/api ── contracts (business payloads, this change)
      │  ▲            ▲
      │  │            │ domain ports only, no concrete adapters
      │  └── application (intake use cases already accepted)
      ▼
infrastructure (postgres adapters, existing)
      ▲
      │ domain (untouched)
packages/bridge-daemon + packages/cli ── contracts (public schemas, device-side subset)
      │
      └── no dependency on services/api types — the daemon speaks the public contract
```

Enforced by the existing dependency-cruiser rules plus two new rules added by this change:

- `services-api-imports-only-public` — `services/api/src` may import `@navis/contracts`, `@navis/domain` ports, and `@navis/application` use cases; never `packages/infrastructure/src` (concrete adapters are injected, not imported).
- `bridge-daemon-not-import-server` — `packages/bridge-daemon/src` and `packages/cli/src` may import `@navis/contracts` only.

The daemon deliberately **re-declares** the public schemas it consumes rather than importing server types (ADR-0001 discipline carried to the device side), exactly as `work-event.ts` already re-declares.

## Task table

| #   | Task                                       | Requirement                  | Standards      | Verify                                    |
| --- | ------------------------------------------ | ---------------------------- | -------------- | ----------------------------------------- |
| 1   | API runtime ADR + service foundations      | all                          | 03, 07, 12     | `pnpm validate`                           |
| 2   | ingest endpoint                            | ingest requirements          | 04, 06, 07, 08 | `pnpm --filter @navis/api test`           |
| 3   | query endpoints                            | query requirement            | 06, 10         | `pnpm --filter @navis/api test`           |
| 4   | auth (device flow + device keys)           | auth requirement             | 04             | `pnpm --filter @navis/api test`           |
| 5   | daemon: binding + Outbox + upload loop     | binding, Outbox              | 07, 08         | `pnpm --filter @navis/bridge-daemon test` |
| 6   | CLI + hook                                 | binding                      | 01, 04         | `pnpm --filter @navis/cli test`           |
| 7   | session-internal events + metadata default | session events               | 06             | `pnpm --filter @navis/contracts test`     |
| 8   | hook spec revision + full gates            | bridge-session-hook MODIFIED | all            | `pnpm validate`                           |

## Design decisions

### δ1 — API runtime selection: deferred to an ADR, evaluated now (ADR-0004)

ADR-0004 forbids selecting a runtime before an accepted use case; this change is that use case, so the evaluation is done here and the selection is made in **ADR-0011 (API runtime selection)**, written before any `services/api` code. Six evidence points, per ADR-0004:

1. **Behavior and failure semantics** — the ingest contract requires per-event rejection inside a batch, which maps awkwardly onto frameworks whose handlers resolve per-request. Batch endpoints with partial results are evaluated explicitly, not by accident.
2. **Trust boundary** — the runtime terminates an untrusted network boundary; its request validation must be the schema, and its errors must never carry framework internals (standard 03).
3. **Consumers** — one consumer now (the bridge daemon, JSON over HTTP); a second consumer (a future web app) consumes the same public schemas, not framework types.
4. **Alternatives** — evaluated in ADR-0011; the evaluation criteria, not the winner, are fixed here so the ADR cannot rationalize a choice.
5. **Operational ownership** — whatever is chosen must support typed startup-validated configuration, structured logging hooks, health/readiness probes, and graceful shutdown without bespoke plumbing (standard 12); a choice needing custom wrappers to meet these is rejected.
6. **Exit cost** — the service boundary is the transport adapter, not the application; a runtime swap later re-implements the adapter layer, and the ingest contract survives. Selected only if the swap cost is bounded by the adapter layer.

**Unresolved until ADR-0011 is written**: the specific HTTP framework. Everything else in this design is runtime-neutral: request/response shapes are zod schemas (contracts package), use cases are pure application code, and the adapter layer is where framework specifics live.

### δ2 — Daemon persistence: SQLite WAL (adjudicated, recorded)

The research record adjudicated SQLite in WAL mode with `synchronous=NORMAL`, one transaction per event append, evidenced by crash-injection and concurrent-writer experiments. Recorded as **ADR-0012 (daemon persistence)** for this repository. `node:sqlite` is the driver (built into Node; no native addon build step), matching the existing Postgres path decision.

### δ3 — Real-time channel: not this change

Mid-session invalidation degrades to the Return-time version check (the daemon's Outbox carries `expected_version`; a rejected version triggers a reload). An SSE/WebSocket channel is a follow-up of ADR-0011, not a requirement here. The spec's offline-staleness scenario defines the current contract precisely: stale marker + cache timestamp.

### δ4 — Authorization model: membership table, binary

`project_members(participant_id, project_id)` is the authority; device keys resolve to a participant; a non-member is denied with an authorization token (standard 04: authorization tests prove cross-scope isolation, not only successful access). `role` exists on participants but is unenforced in this change — a future change activates it without touching the wire (the field is already in the contract). Scope on device keys is a reserved empty slot.

GitHub as an identity provider is permitted; GitHub repository permissions are explicitly **not** an authorization source (the "humans enact" rule cannot live in repository permissions).

### δ5 — Privacy default: metadata class

The default privacy class is `metadata` — hashes, lengths, bounded summaries; content never leaves the machine. The owner may raise a project to `work` (full event payloads); a user may only lower their own project, never raise above the owner's floor. `privacy_class` lives on the binding table and gates the normalization step, so promotion is a config change with no code path.

### δ6 — Multi-organization extensibility: protocol carries no org assumption

Single-organization self-hosting is the deployment model (owner decision). The protocol layer (`contract_version`, event envelope, auth tokens, query responses) contains no organization field. Any future multi-org work adds server-side isolation on top of the membership table without a wire change. **Review enforces this**: a design that makes any client organization-aware violates the constraint and is rejected.

### δ7 — Context loading: state-version driven

`context_summary` is a structured six-field object with no character cap. The daemon records `last_loaded_state_version` on the binding. Session start compares; equal → no-change marker; advanced → fresh summary + record. `session.resumed` and idempotent `reused` hook results never re-inject. Offline → cached summary marked stale with a cache timestamp. This replaces the deleted 200-character ceiling, which was unworkable for a structured summary.

### δ8 — Event identity, causation, and the dedup read (task 3.1)

The Canonical Work Event envelope (accepted, `work-contracts`) carries no `event_id` and no `causation_id`: identity and causation are ledger-side concepts, not extraction concepts. The ingest event wrapper — the layer that exists precisely for ingest-specific claims the envelope does not own — carries them instead:

- `event_id` (required): the daemon assigns it at capture (the Outbox record id, a UUIDv7) and re-sends it with every attempt. The server dedups on `(event_id, device_id)` verbatim — no content addressing, so ledger ids stay time-ordered UUIDv7s and a re-send of an already-acked batch is a no-op at the server.
- `causation_id` (optional): the daemon links each event to its predecessor; the server copies it into the ledger envelope, making session order recoverable by replay.

`EventStore` gains two small reads, both engine-neutral, because the existing methods cannot answer the ingest flow without an unbounded scan:

- `headSeq(projectId)` — the current ledger head, the `expectedSeq` carrier for the batch append.
- `existingEventIdentities(projectId, eventIds)` — set membership plus the authoring device, which is what the `(event_id, device_id)` pair check needs.

The use case maps each surviving wrapper to a ledger envelope following the capture flow's convention (aggregate anchored on the project, `state_version` repeating the latest snapshot's version — every ingest event is an observation, none increments Project State). Payload verification is a per-project switch the route injects (G7); a batch append conflict is thrown, not swallowed into a per-event token: it is transient and the daemon's retry budget owns it (standard 08).

### δ9 — Ingest composition root placement

`createApiServer` and the route factories stay port-only; the process entry composes concrete adapters. The composition root is the single place `services/api` may import concrete adapters, and the boundary rule exempts exactly that file — business code (everything else under `services/api/src`) still imports ports only.

Per `docs/standards/00-index.md`, this change selects:

| Standard                       | Why                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| 01 code                        | Package structure, naming, constants policy                                                  |
| 02 testing                     | Scenario→test mapping; real-engine adapter tests; no flaky tests                             |
| 03 errors and observability    | Boundary-owned errors; structured logs; audit separation                                     |
| 04 security                    | Threat model; device keys; deny-default; cross-scope isolation tests                         |
| 05 documentation               | TSDoc on public exports; why-comments                                                        |
| 06 contracts and compatibility | Runtime schemas; additive evolution; version negotiation                                     |
| 07 data and persistence        | Schema/migration discipline; SQLite WAL; Postgres additions                                  |
| 08 concurrency and reliability | Outbox state machine; retry budgets; crash recovery                                          |
| 09 dependencies                | Runtime dependency admission evidence (node:sqlite is built-in; HTTP framework via ADR-0011) |
| 10 performance                 | Batch budgets; payload reference; bounded queries                                            |
| 11 CI and release              | Frozen graph; three-platform CI; gates fail the build                                        |
| 12 operations                  | Startup-validated config; liveness/readiness; graceful shutdown                              |
| 13 UI                          | Not selected — no browser UI in this change                                                  |

## Alternatives considered

- **One change per side (server, then daemon)**: rejected — they are one capability boundary; splitting would orphan the daemon's contract from the service that defines it. The task order (server first, daemon after) preserves sequential review.
- **Postgres-only daemon storage**: rejected — device-local storage must not require a database.
- **Universal request envelope**: rejected by ADR-0003 (each operation owns its request schema; transport concerns use headers).
- **Hook passes project_id**: rejected — the daemon owns the binding decision; the caller supplies only `cwd`, `toml_present`, `toml_project_id`.
- **Forward-compatibility shims for the rolled-back local-side artifacts**: rejected — nothing is live, no backward compatibility.

## Unresolved decisions

- δ1's runtime winner — closed by ADR-0011 before task 2 starts.
- Whether the query endpoints need a read-model cache beyond the ledger replay — measured in task 3 against a budget; if replay under the budget, no cache (YAGNI, standard 01).
- Windows keychain fallback when libsecret is absent — resolved in task 5 with an encrypted-file fallback gated behind a test that documents the downgrade.

## Evidence

- Research record: the completed research repository that closed this design space (binding, Outbox, auth, loading, cross-platform, experiment evidence).
- Main repo: 740 passed / 43 skipped, 100% line coverage, OpenSpec strict 14/14.
- Existing accepted specs consumed: `work-contracts` (event envelope), `command-intake-idempotency` (idempotency envelope pattern), `project-state-kernel` (replay + projection), `bridge-session-hook` (hook schema being MODIFIED here), `bridge-lifecycle` (single-instance daemon contract).
