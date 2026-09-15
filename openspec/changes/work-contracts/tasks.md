# Tasks: work-contracts

## 1. Canonical Work Event

- [ ] 1.1 Implement `work-event.ts`: envelope schema (`schema_version`, `event_type` discriminator enum of six, `occurred_at`, `project_id`, `source_runtime`, `source_session_id`, `raw_ref`, `extractor_version`, `confidence`, `review_status`), typed per-type payloads, producer-strict / consumer-tolerant parsing paths, unsupported-version rejection. — Requirement: canonical work event envelope; Standards: 01, 02, 06; Unit: packages/contracts; Verify: `pnpm --filter @navis/contracts test`
- [ ] 1.2 Golden fixtures + tests: one valid fixture per event type; negative cases for missing provenance fields; unknown-field tolerance on consumer path; `schema_version` bump rejection. — Requirement: canonical work event envelope; Standards: 02, 06; Unit: packages/contracts tests; Verify: `pnpm --filter @navis/contracts test`

## 2. Equip contract

- [ ] 2.1 Implement `equip-contract.ts` covering the issued-equip public subset (id, state_version, work_id?, participant_id?, causal_snapshot, verified_facts, active_assets, active_holds, boundary?, acceptance_criteria?, allowed_actions?, issued_at, status) with normative documentation that `allowed_actions` is descriptive-only and never authorizing. — Requirement: equip contract; Standards: 01, 05, 06; Unit: packages/contracts; Verify: `pnpm --filter @navis/contracts test`
- [ ] 2.2 Golden equip fixture aligned with the kernel's issued shape, plus a fixture-drift test proving internal kernel refactors do not silently move the contract (fixtures are hand-maintained, never derived from domain code). — Requirement: equip contract; Standards: 02, 06; Unit: packages/contracts tests; Verify: `pnpm --filter @navis/contracts test`

## 3. Return contract

- [ ] 3.1 Implement `return-contract.ts`: submission schema (equip_id, expected_version, candidates as strict kind/provenance/content seeds with lifecycle and scope absent and rejected, effects as asset_ref/description seeds, optional causal_context; actor and timestamp not accepted from the body) and result schema ({absorbed_candidates, absorbed_effects, conflict_marked?: true}); rejection shaped through the existing Problem Details profile with stable reason tokens. — Requirement: return submission contract; Standards: 01, 02, 06; Unit: packages/contracts; Verify: `pnpm --filter @navis/contracts test`
- [ ] 3.2 Tests: positive submission; forged lifecycle/scope rejection; body-carried actor/timestamp rejection; version-conflict rejection expressed via Problem Details with stable token and no internals leak. — Requirement: return submission contract; Standards: 02, 04 (leak surface), 06; Unit: packages/contracts tests; Verify: `pnpm --filter @navis/contracts test`

## 4. Barrel and export surface

- [ ] 4.1 Export the new schemas and inferred types from `packages/contracts/src/index.ts` with per-type id metadata consistent with existing conventions. — Requirements: all three work-contracts requirements; Standards: 01, 05; Unit: packages/contracts; Verify: `pnpm --filter @navis/contracts build`

## 5. Gates

- [ ] 5.1 Full validation sweep: `pnpm validate` (format/build/lint/typecheck/boundaries/test/openspec strict) all green; `openspec validate work-contracts --strict` green. — Requirement: all; Standards: 02, 11; Unit: repo; Verify: `pnpm validate && pnpm exec openspec validate work-contracts --strict`
