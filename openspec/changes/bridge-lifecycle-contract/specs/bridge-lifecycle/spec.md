# Specification: bridge-lifecycle

## ADDED Requirements

### Requirement: Bridge process embeds a single-socket, single-instance lifecycle

The Bridge daemon SHALL live in a single Unix-socket path per user, start exactly once when a client first connects, and be reconnected to thereafter — the connect function MUST NOT spawn a second process. When the daemon exits, a fresh process MAY be started at the next connect and `onExit` callbacks SHALL fire exactly once per exit event.

#### Scenario: first connection spawns the daemon

- **WHEN** a client tries to connect and `probe()` reports `'missing'`
- **AND** the caller invokes `ensureRunning()`
- **THEN** the result carries `created: true` and a real process ID
- **AND** the very next query to `probe()` returns `'running'`

#### Scenario: every later connect reuses the same daemon

- **WHEN** a client connects while `probe()` reports `'running'`
- **AND** the caller invokes `ensureRunning()`
- **THEN** the result carries `created: false` and the identical `pid`
- **AND** no second process is started, any number of concurrent callers all get the same `pid`

#### Scenario: exit is observable in order

- **WHEN** the daemon has been started at least once
- **AND** the daemon process is torn down by an external actor (or simulated exit for contract tests)
- **THEN** any `onExit` hook that was attached fires exactly once
- **AND WHEN** `probe()` runs after the hooks fired
- **THEN** the probe returns `'missing'`

#### Scenario: restart after exit claims a new process id

- **WHEN** the daemon has exited once and a new client connects
- **THEN** `ensureRunning()` returns `created: true` and a _different_ `pid` from the previous run
