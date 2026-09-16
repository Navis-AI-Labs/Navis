# Proposal: command-intake-idempotency

## Why

The kernel applies every command exactly once per accepted submission — but nothing protects the path into it. A retrying client, a flaky transport, or a manually resent form submits the same logical command twice and the ledger applies it twice: the append-only fact record fractures at its only entry door. The event envelope already carries an optional `idempotency_key` and the Postgres migration already defines a `command_inbox` table with `UNIQUE (project_id, idempotency_key)`; both sit unused because the port, the use case, and the adapters that would make them mean anything do not exist. This change lands the command-intake capability: one engine-neutral port, one Application dispatch use case, and two adapters, so an identical submission is replayed from its first result and a same-key-different-payload collision is refused loudly.

## What Changes

- Add the `CommandInbox` output port in `packages/domain/src/ports/`: claim-or-replay begin semantics (`fresh` / `replay` with the stored result / `processing` for an in-flight claim, / explicit mismatch refusal) and completion (`applied` / `failed` with a stored deterministic outcome reference).
- Add the Application dispatch use case `dispatchCommand` in `packages/application`: claim → execute against the rebuilt kernel → append events → complete the claim; a kernel rejection is recorded as `failed` and replayed identically, so a retry never re-executes.
- Add the in-memory and Postgres adapters for the port with one contract suite, the Postgres one racing through the existing `UNIQUE` constraint.
- Refuse a same-key/different-payload resubmission explicitly (payload-hash mismatch is never silently replayed).

## Capabilities

### New Capabilities

- `command-intake`: idempotent command entry — claim lifecycle, replay semantics, dispatch use case, adapter parity.

### Modified Capabilities

- `persistence-ports`: no change; the EventStore port's operation list is untouched.

## Impact

- `packages/domain`: new port file `src/ports/command-inbox.ts`.
- `packages/application`: new use case `src/intake/dispatch-command.ts`.
- `packages/infrastructure`: new adapters `in-memory-command-inbox.ts` and `postgres-command-inbox.ts`; the existing `command_inbox` migration table is reused unchanged.
- No new npm dependencies; `crypto.sha256(canonicalJson(...))` supplies the payload hash.

## Non-Goals

- No HTTP/route/transport wiring: intake is an Application use case consumers compose later.
- No wedged-claim recovery: a claim left `received` by an append/complete crash is re-delivered only by the separate crash-recovery follow-on; this change never re-executes on `processing`.
- No Effect Ledger execution: side-effect execution and its crash semantics are untouched.
- No change to the EventStore port operations or the `command_inbox` migration.
