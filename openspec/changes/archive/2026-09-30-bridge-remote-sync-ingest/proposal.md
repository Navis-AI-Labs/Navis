# Proposal: bridge-remote-sync-ingest

## Why

Navis has a verified domain kernel (append-only ledger, replay-verified projection, idempotent command intake, Canonical Work Event envelope — 740 tests, 100% line coverage) but **no running system**: zero HTTP endpoints, no service process, no local daemon. The kernel is a body without limbs. Agents cannot yet leave a session and have their work enter a Project.

The design space behind this change was closed by the research record: the binding table and Outbox state machine, the privacy classes and session-internal event minimum set, five cross-platform differences, the first-run flow and device-flow auth, state-version-driven context loading, and experiment evidence for crash recovery, concurrency, real network faults, and the seq-gap fix. Those decisions are in force and are not re-litigated here; this change implements them.

This change turns that design into the first runnable two-sided Navis: a service that receives and queries session events, and a local daemon that binds a repository, buffers offline, and uploads reliably — with authentication, cross-platform parity, and privacy defaults baked in.

## Authorization and scope

This change is authorized by the owner. The server-side ingest endpoint, query endpoint, device management, daemon, and CLI land in **this repository alongside the domain kernel**, in one change, with **no backward compatibility** (nothing is live). The research record behind each design decision is summarized inline in `design.md` so a reviewer never needs a second checkout.

## What changes

**Server side — new workspace unit `services/api`** (first service process; activates the API runtime gate of ADR-0004 and the "First service process" rows of `docs/foundation-readiness.md`):

1. `POST /api/ingest` — accepts a batch of Canonical Work Events; deduplicates on `(event_id, device_id)`; negotiates `contract_version` + `event_schema_version`; optionally verifies per-event `payload_hash` (G7); rejects individual malformed events without rejecting the batch; appends survivors to the event ledger.
2. Query endpoints — `get_project_state` (full three time-planes projection, untruncated), `load_context` (paginated history, filterable by type/time), `search_projects` (permission-filtered).
3. Authentication and authorization — OAuth 2.0 device authorization flow (RFC 8628) login; device registration issuing a long-lived **device API key** (scoped to the human participant + device); server-side enforcement of the project membership table; key revocation invalidates the device immediately (subsequent uploads quarantine with an explicit reason).
4. Production foundations for the service — typed startup-validated configuration, structured logs with redaction, W3C trace context, health/readiness probes, graceful shutdown. No business handler lands before these exist (foundation-first rule, `docs/development.md`).

**Local side — new workspace units `packages/bridge-daemon` and `packages/cli`** (built fresh; earlier rolled-back local-side artifacts stay rolled back):

5. Bridge daemon — cross-platform IPC endpoint (Unix domain socket on macOS/Linux, named pipe on Windows), single-instance lock, the binding table (`local_dir`, `project_id`, `mapping_id`, `policy_version`, `contract_version`, `remote`, `privacy_class`, `toml_fingerprint`, `bound_at`, `device_id`, `last_loaded_state_version`, `parent_binding_id` — local-only, never uploaded), an Outbox over SQLite WAL with the state machine `captured→normalized→pending→sending→acked` plus terminal `local_only`/`quarantined` states (terminal states are retained, prunable only by explicit policy), `seq` assigned to pending events only (a local-only event never opens a gap in the server-side sequence), and the upload loop (batch 50, ack-then-delete, bounded retry with backoff).
6. CLI — `navis init/status/session/bridge link/unlink/login`; the session-start hook command (walks cwd upward for `navis.toml`); stateless, shipped in the same package as the daemon, lazily spawns the daemon.
7. Session-internal events — the daemon extracts `user.message` / `agent.message` / `tool.call.requested` / `tool.call.result` into the Canonical Work Event envelope (already accepted in `work-contracts`); default `metadata` privacy transmits only hashes, lengths, and bounded summaries — content stays local.

**Contract side — `packages/contracts` extension:**

8. Schemas for the ingest request/result, the query responses, the device-auth flow (device code, token exchange, device key), and the binding-table hook result shape (`context_summary` as structured fields with **no character cap**).

**Spec side — MODIFIED to the accepted `bridge-session-hook`:**

9. The hook result gains `toml_present` / `toml_project_id` inputs and a structured `context_summary`; the daemon decides the project from the binding table rather than the caller passing `project_id` (closes the schema opened by the archived `bridge-session-hook` change).

## Capability

- `bridge-remote-sync` (new) — ingest, query, auth, binding, Outbox, session-internal events.
- `bridge-session-hook` (MODIFIED) — hook schema revision.

## Non-goals

- **No web application** — no browser UI; `apps/web` waits for an accepted user workflow and a Web ADR.
- **No multi-tenancy / organization isolation** — single-organization team self-hosting (owner decision). The protocol layer carries no organization assumption, and that constraint is enforced by review: any design that makes a client organization-aware violates it.
- **No nested toml / monorepo multi-project** — one toml per repository root; inner tomls are ignored. `parent_binding_id` is a reserved placeholder, always null.
- **No fine-grained permissions** — membership is binary (member/non-member); the `role` field on participants already exists but is not enforced. Device keys reserve a scope slot (empty now).
- **No GitHub-authorization bridging** — GitHub may serve as a login identity provider, but authorization is decided by Navis's own participant table (the kernel's "humans enact" rule cannot be expressed by repository permissions).
- **No real-time channel for mid-session invalidation in this change** — mid-session state invalidation degrades to the Return-time version check (blueprint §11.2); SSE/WebSocket selection is deferred to the runtime ADR's follow-up.
- **No new domain behavior** — the kernel is untouched; this change wires existing accepted behavior to transports.
- **No minimal UI** — no user workflow requires one yet; the first service serves machine clients.

## Affected boundaries

- `services/api` — **created** by this change (API runtime ADR admitted first).
- `packages/bridge-daemon`, `packages/cli` — **created** by this change.
- `packages/contracts` — extended with business payloads (additive; new `schema_version` 1 families).
- `packages/domain`, `packages/application`, `packages/infrastructure` — consumed, not modified (unless the runtime ADR finds a gap, which becomes an explicit design decision).
- `docs/architecture.md` — the `services/api` row moves from planned to admitted; the dependency graph gains the new edges.
- `docs/foundation-readiness.md` — the "First service process" rows move from Deferred to implemented.

## Material decisions requiring an ADR

- **API runtime selection** (HTTP framework, JSON profile wiring, real-time channel option) — ADR-0004 forbids selecting before the first accepted use case; this change is that use case. Evaluated against ADR-0004's six evidence points in `design.md` δ1.
- **Daemon persistence** — SQLite WAL (`synchronous=NORMAL`, one transaction per event) is already decided in the research record and evidenced by crash and concurrency experiments; recorded as an ADR for this repository.

## Review evidence

- Research record: the completed research repository that closed this design space (binding, Outbox, auth, loading, cross-platform, experiment evidence).
- Main-repo baseline: clean tree, `pnpm validate` seven gates green, 740 passed / 43 skipped, OpenSpec strict 14/14, no active change before this one.
- Every requirement below maps to at least one scenario with a verification command in `tasks.md`.
