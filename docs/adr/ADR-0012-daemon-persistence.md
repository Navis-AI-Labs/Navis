# ADR-0012: Daemon persistence

- Status: Proposed
- Date: 2026-09-26

## Context

The active change `bridge-remote-sync-ingest` admits `packages/bridge-daemon`, whose Outbox buffers session events on the user's machine and uploads them when the network is available. The Outbox must survive process death (including `SIGKILL` mid-upload), keep captured events until the server acknowledges them, and never give a local-only event a slot in the server-side sequence.

Constraints fixed by the change spec:

- Terminal states (`local_only`, `quarantined`) are **retained**, prunable only by explicit policy — deletion is not a state machine transition.
- `seq` is assigned to pending events only; a local-only event carries `null` so it never opens a gap in the server-side sequence.
- A record is deleted only after the server acknowledges the batch it belonged to.
- The daemon is per-user, single instance; the Outbox is the only writer to its database file.

## Decision drivers

1. **Crash recovery** — the failure mode that matters is death mid-upload. The store must be readable and consistent after `SIGKILL`, with no lost events and no duplicated events on resume.
2. **Zero-operational local cost** — the user's machine must not run a database server, require a version pin beyond Node, or need a native build step. A team self-hosting the server should not need one at home.
3. **Standards** — standard 07 (schema and migration discipline, durability), standard 08 (retry budgets, crash recovery, reconciliation of unknown outcomes), standard 09 (dependency admission: a runtime dependency only for a capability the platform lacks).
4. **Exit cost** — the Outbox is behind the daemon's own repository boundary; swapping the store re-implements that boundary, not the state machine.

## Proposed decision

Select **`node:sqlite` (Node's built-in SQLite)** as the daemon persistence engine, configured as:

1. **WAL journal mode, `synchronous=NORMAL`** — verified live on this runtime (Node 24.19.0): a real file database reports `journal_mode=wal` and `synchronous=1` after the pragmas, and the `-wal` sidecar is created. WAL gives readers a consistent snapshot while the writer appends; `NORMAL` is the correct durability point for a machine-local buffer whose authoritative copy is the server — a crash can lose the last uncommitted transaction, but the server's ack-then-delete contract means a lost uncommitted event is re-captured from its source on the next session, not silently dropped.
2. **One transaction per state transition** — every Outbox advance (`captured→normalized`, `normalized→pending`, `sending` claim, `acked` deletion) is a single transaction. A transition either lands or does not; after restart the daemon loads every non-`acked` record and resumes from its recorded state, which is exactly the "reconcile, don't blindly retry" posture standard 08 requires.
3. **Idempotent resume by design** — the upload loop claims a batch by advancing records to `sending` **before** sending; on restart, a record found in `sending` is reset to `pending` and re-sent. Because the server deduplicates on `(event_id, device_id)`, a re-send of an already-acked batch is a no-op at the server. Crash mid-send therefore cannot duplicate or lose events, which is the property the change spec demands.
4. **`seq` assignment is a transition, not a column default** — `normalized→pending` computes and writes `seq`; local-only records never enter that transition, so their `seq` is `NULL` by construction, not by cleanup.
5. **Pruning is a separate, explicit operation** — terminal-state rows stay in the database until a pruning command runs with its own policy (age, size). Nothing in the state machine deletes them.
6. **Migration discipline mirrors the server** — versioned plain-SQL files tracked in a `schema_migrations` table with checksums, the same shape as the Postgres path in `packages/infrastructure`, so the two persistence boundaries share one reviewable convention.

## Consequences

- `packages/bridge-daemon` gains no runtime dependency: `node:sqlite` is built into the pinned Node runtime. Standard 09's admission bar (concrete capability, named consumers, comparison against the platform) is met by construction — there is no dependency to admit.
- WAL requires a writable directory and creates `-wal`/`-shm` sidecars; the daemon owns its data directory and its cleanup on shutdown (checkpoint + close).
- The platform's SQLite is the single local truth; a corrupted database is recoverable from the server's own ledger plus the session sources, which the spec's offline-staleness scenario already describes as the degraded mode.
- If a future change needs cross-device local state, it re-opens this ADR rather than bolting on a second store.

## Alternatives

- **LevelDB / RocksDB-style key-value store** — rejected: a key-value layer does not buy durability semantics beyond SQLite's, requires a native dependency, and forces the state machine to be reimplemented as key ranges with no transactional guarantee across a batch claim.
- **JSON/NDJSON log file, append-only** — considered for its simplicity: appends survive crashes, but the "delete only after ack" and "claim a batch by moving state" transitions require rewriting the file, and a partial rewrite after `SIGKILL` can corrupt the whole buffer. SQLite's WAL handles exactly this failure with a checkpoint.
- **Postgres on the user's machine** — rejected: a team self-hosts the server, not the user's laptop; the deployment model forbids a local database server.
- **Encrypted-at-rest file store** — rejected for the Outbox itself (it holds metadata by default, and the privacy class that demands encryption is decided per event; field-level protection belongs to the event normalization step, not the store).

## References

- ADR-0004 Runtime selection gates (evidence points)
- `docs/standards/07-data-and-persistence.md`, `08-concurrency-and-reliability.md`, `09-dependencies-and-supply-chain.md`
- Active change `bridge-remote-sync-ingest` spec (Outbox, binding, session-internal events requirements)
- Live verification on the pinned runtime: WAL and `synchronous=NORMAL` confirmed on a real file database; per-event-rejection batch handling confirmed against a built-in HTTP listener
