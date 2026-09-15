# ADR-0008: Snapshot identity, capture recovery, and strength evaluation

- Status: Proposed
- Date: 2026-09-07
- Updated: 2026-09-09

## Context

The event ledger grows independently of the Project's business state version. A snapshot keyed only by that version would stop advancing during normal work. Capture also crosses asynchronous persistence boundaries, so a live projection may change before the write completes. These constraints require a cursor-bound observation and an explicit recovery contract.

Asset retention needs a suggestion mechanism, but Delivery and Hold references observe only some forms of use. Lack of these references cannot establish that project knowledge is useless.

## Proposed decision

1. Identify a snapshot by project and event sequence. Store the business version as metadata. Verify the committed cursor, accept identical retries, reject differing content at the same cursor, and load the highest sequence. The undeployed baseline SQL changes directly; the migration checksum guard remains.
2. Keep runtime projection shapes in Domain state/projection, with types inferred from schemas that reuse domain field constraints. Restore validates structure and project/cursor metadata, then uses the same event applier for the tail. History and actor registration checks still read the complete log. Full replay remains the semantic integrity audit.
3. Keep capture in Application, consuming only Domain's EventStore port. Own one observation before awaiting, and derive the time anchor from its covered event. The kernel holds no store.
4. Classify permanent events atomically with append. Unknown event families stay permanent; only declared archival families may receive post-snapshot marks. Existing classifications are first-write-wins. Capture writes marks before the snapshot, so interrupted writes leave harmless annotations and can be retried.
5. Keep capture policy in project state, with a dedicated human-only, reason-gated event. The 500-event/7-day defaults remain; policy updates do not change the business version or invalidate Equip.
6. Keep strength a pure read path. Three observed works are the floor; 0.5 is neutral and 0.2 is the suggestion threshold. Missing reference observations remain neutral. Recency parameters are an uncalibrated baseline, not evidence of business effectiveness. Suggestions require an explicit human lifecycle command and never change Acceptance.

## Consequences

- The active change is intended to validate complete command payloads before append, validate recorded event payloads during replay, and enforce event identity uniqueness in both adapters. Review found these guarantees are not yet complete; the active change must close them before this ADR can be treated as implemented.
- Snapshots can advance repeatedly without a boundary change, and asynchronous capture cannot mix two observations.
- Snapshot-assisted folding is cheaper, but log validation and causal-clock reconstruction remain linear in full history.
- Capture is recoverable across two writes; it is not one database transaction and does not authorize deletion.
- The same real adapter contract and capture suites exercise both implementations, including failures and concurrent writers.
- Authority isolation, Acceptance-only candidate decisions, complete Equip/Checkpoint payloads, and unique intervention identities are required foundations of this change.

## Alternatives

- Business-version snapshot keys: rejected because most events leave that version unchanged.
- Kernel-owned persistence or adapter-owned policy: rejected because they place orchestration in the wrong boundary.
- Wall-clock capture anchors: rejected because retries and replay would depend on process timing.
- Archival classification from one migration backfill: rejected because newly appended permanent events would be unprotected.
- Automatic retirement or a low score from absent observations: rejected because the available signals do not justify either decision.
