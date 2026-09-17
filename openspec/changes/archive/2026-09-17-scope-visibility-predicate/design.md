# Design: scope-visibility-predicate

## Context

The kernel derives Equip content by testing `scope === 'project'` inline at two sites. The five-level scope enum is schema-accepted; the projects' rule ownership is not. Later read surfaces (the read baton, an API much later) would each pronounce their own burn of the rule. Standards selected: 00, 01, 02 (testing behavior matrices), 03 (error factory naming). No data layers to modify; compatibility unaffected for this behavior-preserving cut.

## Decisions

### D1 — One predicate, one signature, domain-owned

A domain module defines `scopeVisibleForProject(scope)` returning a boolean, with a doc comment stating the R0 semantics and the non-goal ("narrower scopes require attribution fields that the schema does not yet carry"). The predicate returns `true` exactly for `project`. The signature is deliberately unary — the level is the only input the schema supports today; more parameters would give call sites room to freelance.

- **Rationale**: ownership discipline beats expressive generality. A predicate anyone can bypass with one argument isn't a predicate.
- **Rejected alternative**: parameterize with viewer identity (participant/session ids) — rejected because no asset field stores those attributions in R0; the signature would imply capability the model does not carry.

### D2 — Both derivation call sites adopt the predicate

verified_facts and active_assets in `issueEquip` call the predicate. No behavior change for any currently-creatable data: today's filter is exactly "project only" for both sites; the predicate codifies that.

### D3 — level coverage pinned by scenarios regardless of producible data

Spec scenarios cover all five levels by construction: kernels tests can write participant/session/task assets directly as events (the schema admits them; nothing in the issuance flow creates them, but the predicate must be safe against a future admitting path). Organization assets are excluded from project derivation explicitly.

- **Rationale**: the rule must hold under data that today's commands cannot produce; tomorrow's admit path must not silently widen Equip.

## Migration and rollback

- **Migration**: none — behavior identical for all stored ledger shapes.
- **Rollback**: revert the change; the predicate is leaf-level (no consumers beyond the two call sites).

## Risks

- **Predicate kernel imports**: module lives in `state/`, no cyclic deps (← scope enum already schema-owned).
- **Test duplication**: existing scenario for task-scope rejection is rephrased into the new naming; behavioral assertions identical.

## Verification plan

- `pnpm exec vitest run packages/domain` — kernel recompiles, existing Equip tests green unchanged, new five-level scenarios pass.
- `pnpm validate` (full gate battery).
