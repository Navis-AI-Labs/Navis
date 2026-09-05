## Why

The accepted kernel runtime stores project state as an append-only event history with a versioned projection, but three behavior gaps remain inside the accepted capability perimeter:

1. Nothing records what the project intends to verify or change next. History and Current State exist; the third time plane has no home, so direction intent lives outside the ledger where no one can audit who proposed it or who signed off.
2. WorkRun rows carry a nine-value status enum in the domain schema, but no transition rules exist — run state can be mutated through pairs that were never accepted, and there is no mechanical notion of a terminal run.
3. Intervention fields exist on WorkRun, but no concurrency rule is enforced: two takeovers can overlap, a participant can take over without ever having been present, and hand-back carries no consequence for the equipment contract.

## What Changes

- Add the **Intended Direction** capability: immutable direction records proposed by human or agent participants, resolved exactly once (confirmed/discarded) by humans only with a mandatory reason, appended to the same event history, never silently mutating Current State.
- Add the **WorkRun execution** capability: the adopted legal transition table (16 pairs), terminal-state immutability, gate evidence for resumptions, actor + reason + revision audit on every transition, multi-read-one-write intervention concurrency, and takeover release forcing a fresh Equip before the run continues.
- Extend the single existing migration `001_events.sql` with the new projection tables directly — the repository is pre-production, no database has consumed this migration, so there is no backward-compatibility surface: the migration file is edited in place rather than layered as an additional migration.
- Every new event is append-only; none of them advance `project_state_version`; all rejections reuse the existing closed error registries (no new tokens).

## Capabilities

### New Capabilities

- `intended-direction` — versioned, separately expressed direction records for a project: propose (human or agent), resolve once (human only), full audit trail, no automatic Current State mutation.
- `workrun-execution` — WorkRun lifecycle: legal transition table, gated resumptions, per-transition audit, multi-read-one-write intervention concurrency, and takeover release forcing re-Equip.

### Modified Capabilities

- None. The `project-state-kernel` capability explicitly excludes WorkRun transition and intervention concurrency rules, the event vocabulary requirement is add-only, and the new gates compose with the existing Equip contract (equip issuance already requires an active project and a current state version).

## Impact

- `packages/domain`: new `src/schema/intended-direction.ts`, transition table + `assertWorkRunTransition` in `src/schema/workrun.ts`, new `src/state/intended-direction.ts` and `src/state/intervention.ts`, kernel commands and replay cases in `src/state/project-state-kernel.ts`, six new closed event types in `src/state/events.ts`.
- `packages/infrastructure`: `migrations/001_events.sql` edited in place to add the `intended_directions` and `workruns` projection tables; wire-unit tests extended to assert the enlarged schema (no new migration file, no compatibility branches).
- `packages/domain/test`: new suites for direction, workrun transitions, and intervention concurrency; existing kernel suites extended for the new surface.
- Standards selected (per `docs/standards/00-index.md`): `01-source-code`, `02-testing`, `03-errors-and-observability`, `04-security`, `06-contracts-and-compatibility`, `07-data-and-persistence`, `08-concurrency-and-reliability`.
- Out of scope (later changes): vector clocks, Type Registry/Interfaces/Link Types, snapshots, scope predicates, Bridge, contracts schemas, UI. Checkpoint-context rebuild after a takeover is explicitly excluded from this change; release permits resuming from the last recorded checkpoint only.
