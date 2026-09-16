# Tasks: command-intake-idempotency

## 1. Port and hashing

- [x] 1.1 Add `packages/domain/src/ports/command-inbox.ts`: `CommandInbox` interface, `BeginResult`/`CommandOutcome` types, collision/unknown-key error factory with `module: 'kernel'` naming discipline, plus `hashCommandPayload(command)` covering canonical JSON → sha256 with algorithm tag. — Requirement: payload fingerprinting; Standards: 00, 01, 07; Unit: packages/domain; Verify: `pnpm exec vitest run packages/domain`

## 2. Application use case

- [x] 2.1 Add `packages/application/src/intake/dispatch-command.ts`: claim → invoke the supplied executor once → complete; replay/in-flight short-circuits; missing-key refusal. Command-to-ledger mapping stays out (D3). — Requirement: dispatch semantics; Standards: 01, 02, 08; Unit: packages/application; Verify: `pnpm exec vitest run packages/application`

## 3. Adapters

- [x] 3.1 In-memory adapter `packages/infrastructure/src/persistence/in-memory-command-inbox.ts`; shared adapter contract suite; unit matrix for begin/complete/collision. — Requirement: inbox port claim semantics; Standards: 01, 02; Unit: packages/infrastructure; Verify: `pnpm exec vitest run packages/infrastructure`
- [x] 3.2 Postgres adapter `postgres-command-inbox.ts` reusing the `command_inbox` table; ON CONFLICT racing claim; real-DB contract run + concurrency winner test. — Requirement: inbox port claim semantics + concurrent claims; Standards: 02, 07, 08; Unit: packages/infrastructure; Verify: `pnpm exec vitest run packages/infrastructure` (PG-gated tests require DATABASE_URL)

## 4. Gates

- [x] 4.1 `pnpm validate` exits 0 and `openspec validate command-intake-idempotency --strict` passes. — Requirement: all; Standards: 02, 11; Unit: repo; Verify: `pnpm validate && pnpm exec openspec validate command-intake-idempotency --strict`
