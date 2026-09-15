# Design: snapshot-strength-foundation

Implementation is paused for review. Command-field admission, replay payload validation, and event-identity uniqueness remain open after a second implementation review found cross-command and cross-adapter gaps.

## Scope and standards

This change activates snapshot capture, restoration, and strength suggestions, and repairs the authority and participation contracts they consume. It introduces no service runtime, transport endpoint, dynamic type registry, scope-query capability, or external effect executor.

Applicable standards: 01 source code, 02 testing, 03 errors, 04 security, 05 documentation, 06 contracts, 07 persistence, 08 concurrency, 09 dependencies, 10 resources, and 11 CI. Service operations and UI requirements are deferred because this change activates neither boundary.

## Ownership

| Owner                             | Responsibility                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Domain state/projection           | Runtime projection schemas and inferred row types, reusing domain field constraints      |
| Domain state/snapshot             | Capture policy evaluation, state serialization, and structural/cursor restoration checks |
| Domain state/strength             | Read-only retention score and human-confirmation suggestion                              |
| Domain state/project-state-kernel | Commands, event history, replay, authoritative versioning, and participation gates       |
| Domain ports/event-store          | Engine-neutral event/snapshot contracts and retention classification                     |
| Application capture               | One detached capture observation and persistence orchestration through the port          |
| Infrastructure persistence        | Concrete in-memory and PostgreSQL implementations and SQL migration                      |

The Application package imports Domain in source. Infrastructure is used only by its tests; services will supply concrete adapters as composition roots. No module receives an independent manifest.

## Snapshot identity and restoration

The projection records the last applied event sequence separately from the business state version. Snapshot identity is `(project_id, seq)`: normal work can advance snapshots without changing the boundary or invalidating Equip. Both adapters verify that the cursor is committed at the supplied business version, preserve identical retries, reject different content at the same cursor, and load the highest sequence.

Snapshot restoration validates envelope shape, projection rows and their keys, project identity, business version, and capture anchor against the covered event. Business rows before project creation are invalid. Row types are inferred from the same runtime schemas used for this validation, removing the prior parallel interfaces and unchecked restore casts.

Object-level refinements remain an open correction: a conditional Acceptance without a rationale is currently accepted by restoration even though the object schema rejects it. Reusing individual fields must not drop cross-field constraints.

The single event applier folds only the post-snapshot tail. History validation and causal-clock reconstruction still scan the complete log, checking actors against registration as of each event. Snapshot assistance reduces projection folding; it does not make total recovery cost independent of history. Full replay remains the integrity audit for structurally valid but semantically incorrect stored projections.

## Capture observation and policy

Before its first await, capture owns the projection, event metadata, and policy for one cursor. It rejects mixed project/version/cursor inputs. Its anchor time comes from the covered event, with no separate caller time or wall-clock input.

Policy defaults remain 500 events or 7 logical days, whichever condition is satisfied. The policy row is seeded at project creation. A human-only, reason-gated event updates positive finite windows forward only. The event is not State-material and does not invalidate Equip.

Capture writes eligible retention annotations before saving the snapshot. If the save fails, the annotations do not delete data or establish replay authority; retry safely encounters them and persists the snapshot. A completed retry at an already captured cursor is a no-op. Conflicting content is explicit failure.

## Retention and PostgreSQL

Permanent classification accompanies append atomically. Only explicitly declared archival event families are eligible after capture; unknown families remain permanent. Existing marks retain their first class. Both adapters operate over existing events, so an absent or extremely large cursor range cannot create marks for nonexistent rows or force an integer-by-integer scan.

Event identity parity is a pending correction: PostgreSQL declares event_id as the ledger primary key, while the current in-memory adapter accepts an identity reused within a batch, across batches, or across projects. The correction must reject the whole conflicting batch before any write. Event identity is distinct from a command idempotency key; silently dropping duplicate rows would break sequence and batch semantics.

The baseline migration remains a single undeployed SQL file. Snapshots gain a sequence key, committed-event foreign key, and payload-cursor constraint. The migration runner serializes concurrent bootstraps with a transaction-scoped advisory lock and preserves its checksum guard. JSON parameters use the driver's JSON binding to avoid double encoding.

A database where the old migration has already run is not silently rewritten. Development validation uses an isolated fresh database; no production compatibility layer is admitted.

## Strength and evidence limits

Strength consumes post-acceptance delivery and Hold references and counts observed works. Below three works, or with no observed references, it returns the neutral 0.5. Missing Delivery/Hold edges cannot prove disuse: knowledge may have been supplied through Equip without producing either edge.

For observed references, the existing baseline uses smooth recency weighting and a bounded staleness penalty. The 14-day half-life, 28-day horizon, 14-day penalty scale, and gain coefficients are uncalibrated model parameters, not measured business facts. They are local to the evaluator. Calibration remains experimental; deterministic range/recency tests establish mechanics only.

A score below 0.2 may produce a legal retirement suggestion with human confirmation required. Neither evaluation nor suggestion modifies authority, Acceptance, or lifecycle. The model never decides content quality.

## Authority and participation corrections

History, live projection, command results, and rebuilt views cannot expose writable authority. Runtime-private fields protect ownership; public values are detached and frozen. Candidate activation and rejection require Acceptance, and Delivery checks for an accepted record. Invalid purge ages fail closed.

### Pending field-contract corrections

Invalid Project/Work titles, Hold severity, Acceptance evidence counts, Delivery targets, and run identifiers currently enter history and fail only at capture. Full replay also accepts an empty Work title, so canonical equality alone cannot establish a valid projection.

The correction validates command data using the owning domain schemas before the first event is appended. Object-level refinements must survive field reuse. Commands report affected fields through the existing error contract and consume validated values; no parallel field limits or generic constants directory is needed. A command that emits several events validates the entire candidate batch before mutating history, projection, or the causal clock.

Replay validates each event's data as well as its envelope and type. The live and restore paths consume the same field constraints. Invalid persisted data fails with its event cursor and field, while valid replay still uses the single applier. Snapshot checks remain an additional cache boundary, not the first place ordinary field errors are detected. Reference existence, ownership, and authorization are state-dependent checks; a syntactically valid identifier cannot establish them.

Per-command validation is preferred over validating the full projection on every write, which would repeatedly traverse unrelated state. Snapshot-assisted recovery still validates covered event data; this does not claim full semantic equality without the separate full-replay audit.

Equip returns its recorded causal snapshot and checks the registered recipient. Return verifies that recipient. Run resumption after a business-version change requires a current Equip for the acting participant; work-scoped equips cannot authorize a different Work. After takeover release, the Equip issuance must follow the release in ledger sequence order, regardless of caller timestamps. Pause checkpoints use domain identifiers and preserve supplied recovery references. Session identities are unique within a run, including closed sessions. Submission criteria match all unconditional human-only command gates. Asset creation and Return candidates use the existing domain field schema; invalid inputs cannot enter a future snapshot.

## Verification

- Shared EventStore conformance runs against both implementations, including cursor conflicts, concurrent appends, JSON round trips, permanent classification, and independent project streams.
- Capture tests persist real events, assert nonempty marks and write order, inject save failure through a delegating port, and verify recovery and concurrent observation isolation on both adapters.
- Domain tests cover public-reference attacks, Acceptance bypass attempts, participation identity, checkpoint recovery, policy errors, snapshot corruption, and restore/full-replay parity.
- Strength tests include real accepted assets and repeatedly equipped knowledge, as well as deterministic relative-time behavior and suggestion isolation.
- Dependency-negative probes verify source and built-package edges against ADR-0001. Final checks are `pnpm validate` and the full real-database suite.

## Decision record

ADR-0008 records snapshot identity, projection ownership, capture/retention recovery, and the limits of the strength baseline. Field validation remains unimplemented. One cross-specification conflict also remains: the object model limits intervention_sessions to 100 while the WorkRun capability permits unlimited parallel participation. The projection currently permits 101 entries that the object schema rejects. The limit must distinguish active capacity from historical records before the shared projection contract can be closed; this design does not silently choose either rule.

Work lifecycle, resource authorization, complete Evidence resolution, and transient-content persistence admission remain separate review items. This change does not implement the future scope-query, transport, or team workflow capabilities.
