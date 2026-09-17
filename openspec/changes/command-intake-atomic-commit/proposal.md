# Proposal: command-intake-atomic-commit

## Why

C1 left one deliberate wedge: between a submission's claim (`status='received'`) and its terminal `complete`, the executor runs outside any transaction. A crash in that window leaves an orphaned received-claim that replays as `processing` forever — the outcome can never be stored or retried, and the payload may have already written events elsewhere. R0 interview guarantees need a recoverable entry, not an eternal no-go.

## What Changes

- Add a transactional intake composition in the Postgres layer: `commandIntakeTransaction(sql, request, execute)` — opens one PostgreSQL transaction, claims inside it, runs the executor's writes (inbox outcome stored via the SAME connection), and commits atomically. In-flight claim + outcome commit both crash together or survive together.
- Document ordered constraints: the executor's writes must route through the transaction-bound ports (inbox/anything with a Postgres adapter bound to the tx), otherwise the guarantee is void with a loud rule in the type/doc.
- In-memory adapter: unchanged — it has no transactions, and the R0 guarantee only binds at the Postgres boundary (added spec scenario spells it out).

## Capabilities

### Modified Capabilities

- `command-intake`: new requirement "Postgres intake commits claim and ledger atomically", plus crash-recovery scenarios (mid-execution failure leaves no partial claim; a retry becomes fresh again).

## Non-Goals

- No recovery-runner or scheduled scavenger for wedged claims (deferred to R1+ per the operative decision record; the atomic transaction moves the wedge out of the failure window for this adapter).
- No change to the `CommandInbox` port signature in `@navis/domain` — the composition lives in infrastructure, callers pick the variant.
- No application-level transactions beyond the intake command boundary.

## Impact

- `packages/infrastructure`: new `postgres-command-intake-tx` module; new PG CI-tagged tests.
- `packages/domain`: spec scenario additions only.
- Risk: any executor that secretly writes through an out-of-transaction adapter defeats the guarantee — mitigated by doc rule + advisory test.
