# Tasks: command-intake-atomic-commit

## 1. Postgres transactional composition

- [x] 1.1 Implement `createPostgresCommandIntake(sql)` in `packages/infrastructure/src/persistence/postgres/postgres-command-intake-tx.ts`: class/factory returning `{ dispatch(request, executeTx) }` that runs `sql.begin(tx => dispatchCommand(new PostgresCommandInbox(tx), request, executeTx))`. — Requirement: Postgres intake commits claim and ledger atomically; Standards: 01, 02, 07; Unit: packages/infrastructure; Verify: `pnpm exec vitest run packages/infrastructure/test/postgres-command-intake-tx.test.ts`

## 2. Tests

- [x] 2.1 CPU/posix test module `packages/infrastructure/test/postgres-command-intake-tx.test.ts` — two fake-wire unit suites: (a) executor throws → a follow-up begin returns `fresh`; (b) success → claim row + outcome are visible and a retry replays without executing again. Also a PG-gated live suite anchored on the existing `DATABASE_URL` pattern. — Requirement: Postgres intake commits claim and ledger atomically; Standards: 02, 07; Unit: packages/infrastructure; Verify: `pnpm exec vitest run packages/infrastructure/test/postgres-command-intake-tx.test.ts`

## 3. Gates

- [x] 3.1 `pnpm validate` exits 0 and `pnpm exec openspec validate command-intake-atomic-commit --strict` passes. — Requirement: all; Standards: 02; Unit: repo; Verify: `pnpm validate && pnpm exec openspec validate command-intake-atomic-commit --strict`
