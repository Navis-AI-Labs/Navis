# Delta: project-state-kernel — pending-effects read predicate

## ADDED Requirements

### Requirement: pending effect recovery predicate

The kernel SHALL expose a read predicate `listPendingEffects(): EffectRow[]` that returns every alive Effect row with status `unknown`. A row marked `late_cancel_received` but still in `unknown` status SHALL remain listed (the late cancel does not settle the fact; only confirmation or failure does). A row whose status has moved to `confirmed` or `failed` SHALL NOT be returned. A soft-deleted, tombstoned, or projected-away row SHALL NOT be returned. This predicate is the single source of truth for the crash-recovery question "which effects still need executor confirmation?" — no caller may re-derive it from `projection.effects` directly.

#### Scenario: unknown effects are pending recovery

- **WHEN** the ledger holds two `unknown` effects — one fresh from `recordEffectIntent`, one stamped `late_cancel_received`
- **THEN** `listPendingEffects` returns both
- **AND** an effect-row count comparison with `projection.effects` also lists both

#### Scenario: confirmed/failed rows leave the list

- **WHEN** one pending-effect row is closed as confirmed
- **AND** another is closed as failed
- **THEN** after closure, `listPendingEffects` omits both

#### Scenario: replay round-trip preserves the same answer

- **WHEN** a kernel contains N pending effects
- **AND** its events are replayed through `ProjectStateKernel.fromEvents` (equivalent to a crash-recovery boot path)
- **THEN** the rebuilt kernel returns an identical pending list under `listPendingEffects`

#### Scenario: cancel-before-settle stays pending

- **WHEN** an effect was late-cancelled (row carries `late_cancel_received: true`)
- **AND** it is still in `unknown` status
- **THEN** `listPendingEffects` still returns the row
- **AND WHEN** the row is closed (any outcome)
- **THEN** the row leaves the pending list immediately
