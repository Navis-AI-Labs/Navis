## MODIFIED Requirements

### Requirement: starting a run requires an equip issued at the current state version

`ready→running` SHALL require, in addition to the transition audit fields: an equip reference whose `state_version` equals the project's current state version and whose `participant_id` equals the acting participant. A missing, stale, or foreign equip SHALL be rejected with the registry `forbidden` error and no event. Furthermore, the target work itself MUST be startable: a missing, tombstoned, completed, or cancelled work SHALL be rejected first — before any equip evaluation — with `forbidden` and detail `work-closed`, and no event. This guard applies to every run-start entry point, so no alternate start path may bypass it.

#### Scenario: starting with a current equip succeeds

- **WHEN** a run is started with an equip issued to the acting participant at the current state version for a non-closed work
- **THEN** the transition succeeds and the run's revision becomes 1

#### Scenario: starting with a stale equip is rejected

- **WHEN** a run is started with an equip bound to an older state version
- **THEN** the kernel rejects with the registry `forbidden` error and appends nothing

#### Scenario: starting a cancelled work is rejected

- **WHEN** `startRun` is invoked against a work whose status is cancelled
- **THEN** the kernel rejects with `forbidden` (detail `work-closed`), appends no event, and this result holds even when a perfectly valid current equip would otherwise admit the start

#### Scenario: starting a completed work is rejected

- **WHEN** any run-start entry point is invoked against a completed work
- **THEN** the kernel rejects identically (`forbidden`, `work-closed`, no event)
