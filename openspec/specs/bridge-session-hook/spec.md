# bridge-session-hook Specification

## Purpose

TBD - created by archiving change bridge-session-hook. Update Purpose after archive.

## Requirements

### Requirement: session-start hook contract

The contract package SHALL define `bridgeHookInvocationSchema` whose shape is `{ hook: 'session.start'; request_id; cwd; toml_present; toml_project_id }` and `bridgeHookResultSchema` with shape `{ status: 'bound' | 'reused' | 'unbound'; event_id?; bound_source?; reason?; context_summary? }`. The daemon decides the project from the binding table; the caller no longer passes `project_id`. `context_summary`, when present, is a structured object (project name, status, `state_version`, active work count, open hold count, last update) with no character cap, plus a state-change marker. Both shapes are closed schemas; any extra key fails validation.

#### Scenario: a bound session returns structured context

- **WHEN** the hook fires for a directory with a verified binding
- **THEN** the result status is `bound`
- **AND** `context_summary` carries the structured fields and the state-change marker

#### Scenario: an unbound session reports the reason

- **WHEN** the hook fires for a directory with no toml
- **THEN** the result status is `unbound`
- **AND** `reason` is `no_toml`
- **AND** `context_summary` is absent

#### Scenario: a reused request returns the same event id

- **WHEN** the hook fires again with the same `request_id`
- **THEN** the result status is `reused`
- **AND** `event_id` equals the event id of the first `bound` result
- **AND** no new session event is written
