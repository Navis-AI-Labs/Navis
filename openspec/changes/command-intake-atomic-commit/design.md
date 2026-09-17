# Design: command-intake-atomic-commit

## Context

C1 built the once-only envelope but deliberately moved the crash wedge out of the ring: begin → execute → complete are three calls with a crash window between them. The research-level adjudication (single-transaction option) closed that window conceptionally; this change delivers it. Standards selected: 02 (tests), 03 (errors), 07 (data/transaction), 08 (concurrency).

## Decisions

### D1 — Transaction is composed in infrastructure, not in the application layer

The application `dispatchCommand(inbox, request, execute)` keeps its shape — no new parameters (no tx handle flowing through app code). Instead the Postgres layer exports a composition:

- `createPostgresCommandIntake(sql)`: returns an object with `.dispatch(request, executeTx)` where `executeTx` receives the same request payload and performs its writes bound to the transaction. Internally: `sql.begin(async tx => { const inbox = new PostgresCommandInbox(tx); return dispatchCommand(inbox, request, executeTx); })`.

**Rationale**: port signature unchanged (domains stay neutral); the executor's "writes through this tx" is a type-level and doc-level rule that callers assembling a Postgres graph wire by passing `tx`-bound adapters to the executor closure.

### D2 — Rollback is the crash-recovery semantics; no scavenger

If the executor throws or the tx aborts, everything disappears — the next identical submission starts `fresh`. The wedged `received` row simply cannot persist. The R1 scavenger idea stays parked; the blocker is closed by the invariant "no partial transaction".

**Allowed caveat**: the in-memory adapter retains its non-transactional semantics and C1 behaviors unchanged.

### D3 — Guarantee boundary is Postgres-only and spelled out

Spec scenarios pin: (a) failure → retry is fresh; (b) success → claim+outcome commit together; (c) explicitly NOT for the memory adapter. A readme note in the new module names the rule "executor must write through tx-bound adapters".

## Migration and rollback

- No schema changes; existing `command_inbox` table reused as-is.
- Migration risk: none (composition is additive).
- Rollback: drop the new module; C1 path stays untouched.

## Risks

- **Executor secretly writes via non-tx adapter**: mitigated by doc + an advisory test that the tx object itself is what the inbox receives (instance check inside the factory).
- **Long-lived tx during slow executors**: R0 traffic is low; executor is bounded. R1 scavenger revisits if wedged rows reappear.

## Verification plan

- Adversarial: simulate executor throw inside tx → assert `BEGIN ... INSERT` was rolled back by re-beginning and seeing `fresh`.
- Positive: run full C1 contract suite _through the tx composition_ for the Postgres adapter (the composition returns the same response shape).
- Local PG test wired to the existing `DATABASE_URL` gated harness (43 existing gated tests run there).
- `pnpm validate` end-to-end.
