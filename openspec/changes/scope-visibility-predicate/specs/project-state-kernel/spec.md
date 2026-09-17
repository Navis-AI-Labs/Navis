## MODIFIED Requirements

### Requirement: Equip derives the working contract from project state

The Equip is the work contract between human intent and agent execution: it fixes what the agent may treat as fact, what is still withheld, and what effects are allowed. Stale contracts must not silently mix with new state. On request, the kernel SHALL derive an Equip for a work and participant: verified_facts (the ids of lifecycle=active assets visible under the single scope-visibility predicate), active_assets (lifecycle in active/candidate, same predicate), active_holds (status=active hold ids), the current boundary summary and acceptance criteria, the state_version the equip is bound to, and allowed_actions. Scope visibility for Equip derivation SHALL be owned by one domain predicate — no derivation site may test scope inline. In the current model, visible means project scope: participant-, session-, and task-scope assets carry no ownership attribution today and SHALL NOT appear in any Equip-derived set; organization-scope assets belong outside the project and SHALL NOT appear either. Any future change making narrower scopes visible SHALL do so by extending the single predicate with newly admitted attribution fields, never by re-litigating the rule at a call site. Equip is a derived projection: it is never stored as independent business data. Equip issuance MUST fail explicitly when the serialized fact set exceeds the configured size budget (event recorded, diagnostic payload with fact count/serialized length/budget returned). A Return bound to a stale equip version MUST be rejected wholesale (no partial absorption: candidates and effects of a rejected return MUST NOT enter the projection; a rejection event is recorded).

#### Scenario: equip content matches predicate-visible facts

- **WHEN** an equip is requested after two assets are active at project scope and one hold is active
- **THEN** the equip's verified_facts contain exactly those two asset ids and its active_holds contain exactly that hold id

#### Scenario: participant-scope assets never enter facts

- **WHEN** an equip is requested with an active participant-scope asset present
- **THEN** that asset does not appear in the equip's verified_facts or active_assets

#### Scenario: session-scope assets never enter facts

- **WHEN** an equip is requested with an active session-scope asset present
- **THEN** that asset does not appear in the equip's verified_facts or active_assets

#### Scenario: task-scope assets never enter facts

- **WHEN** an equip is requested with an active task-scope asset present
- **THEN** that asset does not appear in the equip's verified_facts or active_assets

#### Scenario: organization-scope assets stay outside the project derivation

- **WHEN** an equip is requested with an active organization-scope asset present
- **THEN** that asset does not appear in the equip's verified_facts or active_assets

#### Scenario: rule lives in one place

- **WHEN** the Equip derivation is inspected
- **THEN** every scope decision routes through the single scope-visibility predicate and no derivation site compares scope literals inline
