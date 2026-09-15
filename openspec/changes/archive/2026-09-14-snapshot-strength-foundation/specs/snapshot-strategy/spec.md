# snapshot-strategy Spec Delta

## Purpose

> **Capability intent** — Long-lived projects need recorded states they can use for continuation while preserving the result of full history reconstruction. Capture policy determines when a snapshot is due; capture records a consistent observation and its retention annotations. Policy values are project state facts and apply forward only.
> **Scope boundary** — This capability defines only: the capture-due policy and its defaults as state facts; the due-detection semantics; the capture flow executed through the port with retention marking; restore-time consumption with canonically identical outcome; explicit rejection of unusable snapshots. Not included: cold-storage eviction (rows are never physically deleted), Equip invalidation diffing, any UI or configuration surface, background workers, and any mechanism that lets a snapshot become a second source of truth.

## ADDED Requirements

### Requirement: capture due-ness follows the accepted mixed policy as a project state fact

Capture due-ness SHALL be observable: a snapshot is due when the number of events since the last capture reaches the count window or the elapsed logical time from that capture's event to the current event reaches the time window. Before the first capture, counting starts at the beginning of the log and elapsed time starts at its first event. Defaults are 500 events and 7 days. The same log, project policy, and previous capture SHALL yield the same answer. Policy changes apply to subsequent evaluations and do not revise earlier capture facts.

#### Scenario: event-count window fires

- **WHEN** the number of events since the capture anchor reaches the event-count window
- **THEN** a snapshot is due at the current event, and the since-counters restart from a capture of it

#### Scenario: time window fires first

- **WHEN** fewer events than the count window have occurred, but the logical time from the capture anchor to the current event has reached the time window
- **THEN** a snapshot is due for the time trigger, and both since-counters restart

#### Scenario: due-ness is log-deterministic

- **WHEN** due-ness is evaluated twice over the same log, policy, and previous capture
- **THEN** both evaluations return the same answer without consulting wall-clock time

#### Scenario: policy values evolve as state facts

- **WHEN** the project changes a policy window value
- **THEN** the change is a state change recorded in the ledger, evaluations after it use the new value, and events and snapshots before it keep the values they were produced under

### Requirement: policy windows are human-gated state carried by a dedicated policy event

Every project SHALL expose capture windows initialized with the accepted defaults at project creation. Updating them is a human-only, reason-gated state change recorded as a dedicated `project.policy_updated` event. The event advances the event sequence and leaves the current state version unchanged, so a policy update does not invalidate existing equips. Agent-attempted updates, missing or blank reasons, and invalid windows MUST be rejected without changing the ledger, projection, or causal clock. The event-count window is a positive safe integer; the time window is a positive finite number of days.

#### Scenario: human policy update takes effect forward-only

- **WHEN** a human actor submits a policy update with a non-empty reason
- **THEN** a `project.policy_updated` event is appended, the policy row advances in the projection, the event sequence advances with the state version unchanged, and subsequent due-ness evaluations use the new windows

#### Scenario: agent policy update is rejected without pollution

- **WHEN** an agent actor submits a policy update
- **THEN** the kernel returns a forbidden error and the event log and policy row are unchanged

#### Scenario: missing reason is rejected

- **WHEN** a policy update arrives with an empty reason
- **THEN** the kernel rejects it without appending an event

#### Scenario: malformed windows are refused

- **WHEN** a policy update supplies a non-positive or non-finite window, or a fractional event-count window
- **THEN** it is refused and all state remains unchanged

#### Scenario: a policy update does not invalidate equips

- **WHEN** a policy update is recorded while equips exist at the current state version
- **THEN** the event advances only the sequence and repeats the state version, so no equip bound to the current version reads as stale — a capture-window change carries no equip invalidation response, by construction

### Requirement: replay consumes a caller-supplied snapshot and stays identical to full replay

Replay MAY begin from a supplied snapshot at a recorded event cursor. A usable snapshot has a supported schema version, valid state structure, matching project identity, and the business version recorded at its cursor. Restoration plus subsequent events SHALL produce the same projection as full replay of that history. Without a supplied snapshot, full replay applies. An unusable snapshot SHALL fail explicitly with the problem identified; it SHALL NOT be silently discarded or substituted. Full replay remains available to audit semantic equality with the stored projection.

#### Scenario: restore plus increment equals full replay

- **WHEN** a usable snapshot is supplied at sequence cursor S and replay runs over a log whose latest event is after S
- **THEN** the projection built as snapshot-restore plus folding events after S is canonically identical to the projection built by folding every event from the beginning

#### Scenario: no snapshot supplied means full fold

- **WHEN** no snapshot is supplied to the replay path
- **THEN** replay folds the entire log and the outcome is identical to the current full-replay behavior

#### Scenario: unusable supplied snapshot fails loudly

- **WHEN** the supplied snapshot's envelope schema version does not match the current projection schema version, or its sequence cursor does not match the log, or its state-version cursor disagrees with the log event's recorded version at that sequence
- **THEN** replay fails with an error naming the snapshot problem instead of returning a silently divergent projection or silently ignoring the snapshot

### Requirement: capture persists the snapshot and its retention marks through the port as one flow

Capture SHALL persist eligible retention marks before the snapshot. The snapshot records the state and policy at capture, its event cursor, business version, and schema version. Retrying the same observation SHALL leave equivalent marks and snapshot content without duplication or corruption. If capture is interrupted after marking, the next attempt SHALL be able to complete without changing event history. Permanent events SHALL never receive archive marks. Retention marks are annotations and never delete ledger rows.

#### Scenario: capture writes marks then snapshot

- **WHEN** a snapshot is captured for the covered range ending at sequence S
- **THEN** the archive-after-snapshot marks for the range are written before the snapshot row, the snapshot row carries its cursors and the policy values in force at capture, and no event classified as permanent is marked

#### Scenario: covered range is explicit and gapless

- **WHEN** a capture covers up to sequence S and the capture anchor records the previous capture's sequence P
- **THEN** the snapshot covers every event through S, and new archive marks apply only to eligible events from P+1 through S; existing permanent classifications and events outside that range are unchanged

#### Scenario: retrying a capture is idempotent

- **WHEN** a capture flow for the same covered range runs twice
- **THEN** the second run leaves the same marks and snapshot content, with no duplicates or divergence

#### Scenario: an interrupted capture is recoverable

- **WHEN** marks have been written but the snapshot row write fails
- **THEN** the ledger is unchanged, the next capture of an overlapping range re-marks idempotently, and replay proceeds as if the interrupted capture never happened

#### Scenario: marking never deletes

- **WHEN** retention marks are written for a capture
- **THEN** every ledger row remains present and replay from the full log continues to produce the identical projection

### Requirement: successive captures follow event progress and preserve one observation

Captures SHALL be identified by their project and covered event cursor, independently of the business state version. A later due capture at the same business version SHALL advance the stored cursor. Retrying an identical capture SHALL be idempotent; different content claiming the same cursor SHALL be rejected. A capture's state, covered events, and logical-time anchor SHALL describe the same observation, even if a command completes while persistence is pending. The anchor time SHALL equal the covered event's logical time. A snapshot that names an uncommitted or inconsistent cursor SHALL not be persisted.

#### Scenario: ordinary work advances capture without a boundary change

- **WHEN** more work events make a second capture due while the business state version is unchanged
- **THEN** the later snapshot becomes the latest stored capture and a retry against the unchanged log is not due

#### Scenario: a command completes while capture is pending

- **WHEN** a capture begins at cursor S and another command completes before persistence finishes
- **THEN** the saved snapshot contains exactly the state at S and restoration matches replay through S

#### Scenario: conflicting content cannot replace a capture

- **WHEN** two snapshots claim the same project and event cursor but contain different state
- **THEN** the second is refused and the first remains unchanged

#### Scenario: restored state and history must both be valid

- **WHEN** a snapshot contains malformed projection rows, mismatched project identity, or inconsistent cursors, or its covered history uses an actor before registration
- **THEN** restoration fails explicitly instead of accepting a history or state that full replay would reject

#### Scenario: permanent classification covers newly appended events

- **WHEN** boundary, acceptance, or other permanently retained events are appended after schema initialization and later captured
- **THEN** they retain their permanent classification; events not explicitly eligible for archival remain permanently retained
