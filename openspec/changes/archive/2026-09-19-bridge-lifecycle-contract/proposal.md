# Proposal: bridge-lifecycle-contract

## Why

The Bridge process (the relay between a local agent runtime and the kernel) cannot first appear in the code in R1. By the DEC-0003 scoping and the R0-22 through R0-25 task rows, R0 admits a verifiable lifecycle contract — single socket path, single-process guarantee, and a deterministic daemon-detection-and-restart story. This change admits the _domain-level contract_, not the transport. It may be replaced by a real socket implementation when R1 arrives.

## What changes

- **A new domain port `BridgeLifetimePort`** in `packages/domain/src/bridge`:
  - `probe(): 'running' | 'missing'`
  - `ensureRunning(): Promise<{ pid: number; created: boolean }>`
  - `onExit(cb)`: register a callback invoked exactly once on a simulated daemon exit
    Semantics come straight from T14: a cold start spawns the process; warm calls return the same PID with `created: false`; an exit forces the next `ensureRunning` to spawn again.
- **An in-memory implementation `InMemoryBridgeLifetime`** in `packages/domain/src/bridge` — the design-verification artifact for this change. Not a real process spawner.
- **A new main spec `bridge-lifecycle`** in `openspec/specs/bridge-lifecycle/spec.md` — the lifecycle contract, its single-process guarantee, single-path invokation, and exit detection are all required scenarios. Spec-level affirmation only; no domain or kernel invariants change.

## What does NOT change

- The kernel domain model, ports, EventStore adapters, or any command vocabulary stays untouched.
- `packages/contracts/` stays untouched.
- Nothing in the code spawns a real process; that is an R1 bridge over this contract.

## New capability

- `bridge-lifecycle` — the lifecycle contract for a local per-user Bridge process.

## Impact

- `packages/domain/src/bridge/` — two new files.
- `packages/domain/test/bridge-lifecycle.test.ts` — scenario tests against the in-memory adapter.
- `openspec/specs/bridge-lifecycle/spec.md` — the new main spec.
- OpenSpec validation surface grows from 13 items to 14.
