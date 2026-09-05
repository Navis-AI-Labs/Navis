# Tasks: vector-clock-merge

## 1. Clock module (pure domain)

- [x] 1.1 Create `packages/domain/src/state/vector-clock.ts`: snapshot type, `compareClocks` (four verdicts, default-0, mirror-consistent, self-equal), `mergeClocks` (component-wise max), `advanceClock` (author component +1); snapshots serialize through the existing canonical JSON path. Requirements: bidirectional-merge four-verdict + monotonic-advance; design D1/D3. Standards: 01, 02. Verify: `pnpm exec vitest run packages/domain/test/vector-clock.test.ts`
- [x] 1.2 Domain tests: generated snapshot pairs covering mirror-consistency, self-equality, default-0 semantics, merge monotonicity, safe-integer bounds. Requirement: four-verdict comparison. Verify: same command, coverage 100% on new module

## 2. Schema and registry additions

- [x] 2.1 Add `causalClockSnapshotSchema` to `packages/domain/src/schema` (participant UUID keys, safe-integer counters, unknown-key rejection); extend equip schema with optional `causal_snapshot`; extend the return command payload with optional `causal_context`. Requirements: equip bootstrap + return verdict; design D3. Standards: 06. Verify: schema unit tests + `pnpm exec tsc --noEmit`
- [x] 2.2 Add event type `return.conflict_marked` to `KERNEL_EVENT_TYPES`; add error codes `causal-context-invalid` and `causal-actor-unregistered` to the registries with `kernel/<token>` URNs. Requirement: return verdict + conflict marking; design D4. Standards: 06. Verify: registry unit tests (add-only closure holds)

## 3. Kernel integration

- [x] 3.1 Advance the authoritative clock on every accepted event in the central append path (actor component +1); reject unregistered actors with `causal-actor-unregistered`; persist `causal_clock` on the project row; extend `rebuildProjection()` to reconstruct the clock from event authorship. Requirements: monotonic advance + replay rebuild; design D2. Standards: 07, 08. Verify: kernel tests — per-event component read-back, unregistered-actor rejection, incremental vs replayed clock equality
- [x] 3.2 Extend `submitReturn`: validate optional `causal_context` (malformed → `causal-context-invalid`, nothing appended), compare at judgment time, record verdict on `return.absorbed` and `return.rejected` payloads, append `return.conflict_marked` in the same transaction on concurrent absorption, keep absorbed candidates unaccepted. Requirements: return verdict + concurrent marking + rejected-return verdict; design D3/D4. Standards: 08. Verify: kernel tests — concurrent/ordered/rejected/no-context/malformed paths, plus two-parallel-returns both marked and later-return-observing-earlier paths
- [x] 3.3 Stamp issued equips with the authoritative snapshot at the equip's state version. Requirement: equip bootstrap. Standards: 06. Verify: kernel test — issued equip carries matching snapshot
- [x] 3.4 Legacy-compatibility pin: a return without `causal_context` produces event payloads with the same shape as the pre-change baseline (no verdict fields, no conflict event). Requirement: no-context scenario. Standards: 06. Verify: kernel test comparing payload shapes

## 4. Persistence

- [x] 4.1 Nullable JSONB `causal_clock` column on `projects`, merged into the base migration (no deployed databases; schema baseline rebuilt wholesale); update wire-level tests for the new column shape. Requirement: replayable read cache; design D2/Migration. Standards: 07. Verify: `pnpm exec vitest run packages/infrastructure/test/postgres-wire-unit.test.ts`; against live DB: `DATABASE_URL="postgres://postgres@127.0.0.1:5432/navis_test" pnpm exec vitest run`
- [x] 4.2 In-memory store passthrough for the project clock field; replay-rebuild equality test (reconstructed clock equals incrementally built clock). Requirement: replay rebuild. Standards: 07. Verify: `pnpm exec vitest run packages/infrastructure/test`

## 5. ADRs and closure

- [x] 5.1 Draft `docs/adr/000N-causal-metadata-vector-clock.md`: mechanism selection with alternatives and the property-based benchmark evidence (independent causal oracle, correctness/scale/topology results, discarded exploratory rounds). Decision: D1. Standards: 05. Verify: ADR review against `docs/adr/README.md` conventions
- [x] 5.2 Draft `docs/adr/000N-clock-retirement-safety.md`: unanimity, atomicity, join-bootstrap prerequisites and the deferred executor boundary. Decision: retirement constraints. Standards: 05. Verify: same
- [x] 5.3 Full repository gate: `pnpm validate` (format, build, lint, typecheck, boundaries, tests, openspec validate --strict) green with the 276-test baseline extended, zero skipped; then request owner acceptance and commit approval
