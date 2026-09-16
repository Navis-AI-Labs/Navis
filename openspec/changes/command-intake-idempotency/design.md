# Design: command-intake-idempotency

## Context

The Postgres migration already defines `command_inbox (project_id, idempotency_key UNIQUE, command_type, payload_hash, status ∈ received/applied/failed, result_ref, created_at)`; the EventStore envelope already carries an optional idempotency key. Neither is consumed: no port, no use case, no adapter. This change turns that stored substrate into behavior. Standards selected: 00, 01, 02, 07, 08.

## Decisions

### D1 — The port is a claim machine, not a queue

The domain owns one output port, `CommandInbox` (ports layer): a begin operation taking project, idempotency key, command type, and payload hash; and a complete operation taking the key and a terminal outcome. Begin answers one of three declared verdicts: fresh (a new claim is installed), replay (an identical terminal claim exists — begin returns its stored outcome), or processing (an identical claim exists but is not yet terminal). An outcome is one of two terminal states — applied or failed — each carrying the stored canonical-JSON result text. Semantics are normative, not code-shaped:

- `begin` on an unknown key installs a `received` claim and returns `fresh`.
- `begin` on a terminal key with an equal hash returns `replay` with the stored outcome.
- `begin` on a non-terminal `received` claim returns `processing`.
- Equal key + different hash fails with a single explicit collision error; `complete` on an unknown key fails loudly.
- The port carries no driver types (ADR-0001 / ADR-0005).

### D2 — Payload hash: canonical JSON → SHA-256

`payloadHash = 'sha256:' + sha256hex(canonicalJson(command))`, reusing the domain canonical serializer. Wire-equal submissions with reordered keys therefore fingerprint identically; any content difference loudly changes the hash. The algorithm tag in the value keeps a future algorithm upgrade additive.

### D3 — The dispatcher wraps a caller-supplied executor; this change owns only the once-only guarantee

`dispatchCommand(inbox, submitted, execute)`:

1. `begin`. On `replay` return the stored outcome untouched. On `processing` return a typed in-flight signal (not an error, not a success).
2. On `fresh`: invoke `execute(command)` exactly once. Success → `complete(applied, canonical(outcome))`; rejection → `complete(failed, canonical(rejection))`.
3. A later identical submission: begin replays; the executor is never invoked again.

The command-to-ledger mapping (rebuild the kernel, append envelopes, transaction shape) is deliberately NOT designed here: no accepted composition exists yet — no code path today maps kernel commands onto event envelopes (aggregate ancestry, privacy classes, and correlations are unassigned). Designing that mapping inside this change would widen its competence from "this submission cannot run twice" into "how the kernel writes to the ledger"; the executor injection keeps this capability laser-narrow while the command-composition design is scheduled with the serving boundary it feeds.

Crash window recorded, explicitly unfinished: between the executor completing and `complete` being called, a crash leaves a `received` claim that later submissions see as `processing`; the redelivery/reconciliation of wedged claims is the crash-recovery follow-on and is out of scope here. Consequences: the system never double-executes; it may wedge a claim until the follow-on change.

- **Rationale**: once-only semantics is what the surrounding code needs first; the executor injection keeps the port free of command vocabulary and event-shape policy.
- **Alternatives considered**: bake rebuild-and-append into the use case — rejected: it invents command mapping before the serving boundary reviews it; single combined port method `execute+complete` — rejected for the same fusion reason.

### D4 — Adapters in lockstep from one suite

- `InMemoryCommandInbox` (Map-backed): the semantic definition of the port.
- `PostgresCommandInbox`: `INSERT ... ON CONFLICT (project_id, idempotency_key) DO NOTHING RETURNING` selects the winner; the loser reads the row and classifies per D1. The existing migration table is used unchanged.
- One shared contract suite runs both adapters plus the PG-only concurrency test; tally joins the adapter parity pattern already used for the event store.

### D5 — Result storage is bounded canonical text

Outcomes are stored as canonical JSON text, capped at 65,536 chars: an oversized outcome records a terminal-failed claim carrying a deterministic refusal marker (the row stays honest and a retry replays the refusal) and the caller sees the failure loudly — no silent truncation, no stored bloat. Today all kernel outcomes are small rows; the cap is a guard, not a quota.

## Migration and rollback

- **Migration**: none — the `command_inbox` table already exists and is reused unchanged; there are no data moves.
- **Rollback**: delete the port/use case/adapters (pure additive code); the table may remain harmlessly unused, or be dropped by a later migration only once product data must write through the intake.

## ADR decision

None. The port shape reuses ADR-0001/0005 direction; the crash-window decision belongs to the effect-recovery follow-on, not to a new ADR here.

## Risks

- **Claim wedge before crash recovery ships**: recorded in D3 as the deliberate, bounded trade.
- **Outcome JSON drift vs kernel shapes**: mitigated by canonical storage with replay tests asserting byte-identity of deduplicated results.
- **Hash algorithm version**: serialized inside payloads (`sha256:` prefix) so an upgrade cannot collide with old rows silently.

## Verification plan

- Domain port unit: begin/complete semantics matrix (fresh → fresh-refusal double-claim, terminal replay, processing, hash collision, unknown-complete).
- Application dispatch: first-applies, replay-no-side-effects, rejection-replays, absent-key refusal.
- Infrastructure: shared adapter contract suite on both adapters + PG concurrency winner test (real database-gated).
- Gates: `pnpm validate` and `openspec validate command-intake-idempotency --strict`.
