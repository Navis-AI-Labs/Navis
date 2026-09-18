## MODIFIED Requirements

### Requirement: equip is a derived contract carrying facts, holds, goal, criteria, and allowed effects

The Equip is the work contract between human intent and agent execution: it fixes what the agent may treat as fact, what is still withheld, and what effects are allowed. Stale contracts must not silently mix with new state. On request, the kernel SHALL derive an Equip for a work and participant: verified_facts (the ids of lifecycle=active assets visible under the single scope-visibility predicate), active_assets (lifecycle in active/candidate, same predicate), active_holds (status=active hold ids **narrowed to the equip's work**: a hold qualifies when its `registered_during_work` equals the equip's `work_id`, OR when `registered_during_work` is unset/null — a hold not attributed to any work is project-wide and SHALL appear in every equip), the current boundary summary and acceptance criteria, the state_version the equip is bound to, and allowed_actions. Active-holds narrowing SHALL be owned by the equip derivation and SHALL NOT be re-applied or shadowed by any consumer (returns processing, read surfaces, adapters). Verified_facts SHALL remain project-wide under the scope predicate: assets carry no work attribution field today, and narrowing facts per work would require a schema change that is out of scope here. Scope visibility for Equip derivation SHALL be owned by one domain predicate; no derivation site may test scope inline. In the current model, visible means project scope: participant-, session-, and task-scope assets carry no ownership attribution today and SHALL NOT appear in any Equip-derived set; organization-scope assets belong outside the project and SHALL NOT appear either. Any future change making narrower scopes visible SHALL extend the single predicate with newly admitted attribution fields, never by re-litigating the rule at a call site. Equip is a derived projection: it is never stored as independent business data. Equip issuance MUST fail explicitly when the serialized fact set exceeds the configured size budget (event recorded, diagnostic payload with fact count/serialized length/budget returned). A Return bound to a stale equip version MUST be rejected wholesale (no partial absorption: candidates and effects of a rejected return MUST NOT enter the projection; a rejection event is recorded).

#### Scenario: equip carries current facts and holds

- **WHEN** an equip is requested after two assets are active at project scope and one hold is active and registered during the equip's work
- **THEN** the equip's verified_facts contain exactly those two asset ids and its active_holds contain exactly that hold id
- **AND** the equip's state_version equals the current state_version

#### Scenario: a hold of another work never enters the equip

- **WHEN** an equip is requested for work W1 while an active hold is registered during a different work W2
- **THEN** the equip's active_holds SHALL NOT contain that hold id

#### Scenario: a project-wide hold enters every equip

- **WHEN** an equip is requested for work W1 while an active hold has no `registered_during_work` (project-wide)
- **THEN** the equip's active_holds contain that hold id
- **AND WHEN** an equip is requested for any other work in the same project
- **THEN** that equip's active_holds also contain that hold id

#### Scenario: verified_facts stay project-wide regardless of work narrowing

- **WHEN** two equips are issued for two different works in the same project
- **THEN** both verified_facts sets are identical (project-wide), while their active_holds may differ
- **AND** this divergence is the contract's canonical expression of "facts are the project's, holds are the work's"

#### Scenario: budget overflow fails explicitly

- **WHEN** the serialized fact list length exceeds the configured budget
- **THEN** equip issuance fails with equip-budget-exceeded
- **AND** a budget-exceeded event is appended and the error carries fact count, serialized length, and budget

#### Scenario: non-project-scope assets never enter facts

- **WHEN** an equip is requested with an active task-scope asset present
- **THEN** that asset does not appear in the equip's verified_facts or active_assets
- **AND WHEN** an equip is requested with an active participant-scope asset present
- **THEN** that asset does not appear in verified_facts or active_assets either (scope isolation)

#### Scenario: session-scope assets never enter facts

- **WHEN** an equip is requested with an active session-scope asset present
- **THEN** that asset does not appear in the equip's verified_facts or active_assets

#### Scenario: organization-scope assets stay outside the project derivation

- **WHEN** an equip is requested with an active organization-scope asset present
- **THEN** that asset does not appear in the equip's verified_facts or active_assets

#### Scenario: the rule lives in one place

- **WHEN** the Equip derivation is inspected
- **THEN** every scope decision routes through the single scope-visibility predicate and no derivation site compares scope literals inline
- **AND** the active-holds work narrowing is applied by the same derivation site, not duplicated by any consumer

#### Scenario: stale return is rejected wholesale

- **WHEN** a return arrives bound to a version older than the current state_version
- **THEN** the kernel rejects with version-conflict
- **AND** the return's candidates and effects do not appear in the projection
- **AND** a return-rejected event is appended
