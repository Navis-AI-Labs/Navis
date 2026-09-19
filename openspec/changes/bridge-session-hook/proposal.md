# Proposal: bridge-session-hook

## Why

R0-25 requires the SessionStart hook contract: when a local agent runtime starts a session, a hook invokes `navis-bridge ensure-running` so the Bridge is always up before any client reads or writes. The hook shape and its response grammar must live in `packages/contracts` next to the other public contracts, or every R1 agent runtime would invent its own.

## What changes

- New file `packages/contracts/src/bridge-hook.ts` exporting:
  - `bridgeHookInvocationSchema` — the hook call shape (hook type + project id + request id),
  - `bridgeHookResultSchema` — the hook result shape (started/reused/failed with pid and reason).
- Closed vocabulary for trigger (`session.start`) and for status (`started` | `reused` | `failed`).
- A test proving schema acceptance/rejection against the scenarios in the new spec.

## Capability

- `bridge-session-hook` — hook contract for local runtime startup.

## Non-goals

- No actual hook runner, no subprocess spawn, no HTTP route. The contract is the entire deliverable.
