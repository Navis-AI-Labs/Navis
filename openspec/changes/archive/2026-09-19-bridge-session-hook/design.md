# Design: bridge-session-hook

## Choice

Single flat file `bridge-hook.ts` in the contracts package, closed zod schemas matching the package's house idiom (see `equip-contract.ts`). No registry additions, no kernel coupling — the hook contract is transport-shaped, not domain-shaped.

## Task table

| #   | Task                       | Requirement               | Standards         | Verify                                                             |
| --- | -------------------------- | ------------------------- | ----------------- | ------------------------------------------------------------------ |
| 1   | `bridge-hook.ts` + exports | invocation/result schemas | 06-contracts      | `pnpm --filter @navis/contracts build`                             |
| 2   | tests                      | scenarios                 | 02-testing        | `pnpm exec vitest run packages/contracts/test/bridge-hook.test.ts` |
| 3   | gates                      | all                       | 11-ci-and-release | `pnpm validate` + openspec strict                                  |
