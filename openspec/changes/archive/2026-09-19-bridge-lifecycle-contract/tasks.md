# Tasks: bridge-lifecycle-contract

## 1. Port

- [x] 1.1 Add `packages/domain/src/bridge/lifetime.ts` exporting `BridgeLifetimePort` with `probe()`, `ensureRunning()`, `onExit(cb)`. Verify: `pnpm --filter @navis/domain build`.

## 2. Reference implementation

- [x] 2.1 Add `packages/domain/src/bridge/in-memory-lifetime.ts` implementing the port deterministically: sequential PIDs, one spawn per missing→running transition, `onExit` fires once per exit. Verify: `pnpm --filter @navis/domain build`.

## 3. Tests

- [x] 3.1 `packages/domain/test/bridge-lifecycle.test.ts`: one test per spec scenario; assured exact count of exit callbacks; concurrency check (Promise.all over concurrent ensures yields one `true` in their `created` array). Verify: `pnpm exec vitest run packages/domain/test/bridge-lifecycle.test.ts`.

## 4. Gate

- [x] 4.1 `pnpm validate` fully green.
- [x] 4.2 `pnpm exec openspec validate bridge-lifecycle-contract --strict` green.
- [x] 4.3 Commit English-only, push, block for CI green before opening next baton.
