# Tasks: bridge-session-hook

## 1. Contracts module

- [x] 1.1 Create `packages/contracts/src/bridge-hook.ts` with both schemas + barrel export. Verify: `pnpm --filter @navis/contracts build`.

## 2. Tests

- [x] 2.1 `packages/contracts/test/bridge-hook.test.ts` — acceptance, rejection-by-extra-key, result-triple coverage. Verify: `pnpm exec vitest run packages/contracts/test/bridge-hook.test.ts`.

## 3. Gate

- [x] 3.1 Gates: prettier, build, lint, typecheck, boundaries, test with 100% coverage gates, openspec strict.
- [x] 3.2 Commit + push English-only; wait for CI.
