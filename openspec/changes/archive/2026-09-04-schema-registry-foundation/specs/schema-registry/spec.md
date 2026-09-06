# schema-registry Spec Delta

## Purpose

> **Capability intent** — When a project describes its work, the vocabulary it may use must have an authoritative, queryable home: which object types exist, how types relate, what a project can start from, and what deterministic checks gate an action submission. This capability provides that home as serializable data — core interfaces with shared capability shapes, named link types with endpoints and cardinality, preset templates as starting vocabularies, a read-only registry of the eight core object types, and a closed submission-criteria contract whose checks are deterministic.
> **Scope boundary** — This capability defines only: the read-only registry of core type descriptors and its closure; interface and link type definitions as data with reference integrity; the two preset templates and their reference integrity; and the submission criteria contract types with one baseline permission check. Not included: registration of project-defined domain types (a later capability via the schema-change acceptance flow), schema-change events or acceptance targets, effect execution engines, schema compatibility windows, LLM generation pipelines, semantic contradiction judgment, and transport or UI surfaces.

## ADDED Requirements

### Requirement: the registry answers which object types exist

The registry SHALL provide lookup-by-name and complete listing over the core object type vocabulary. The registered set SHALL be exactly the eight core object types — Project, Work, TaskSpace, Asset, Acceptance, Delivery, WorkRun, Hold — each as a minimal descriptor carrying its name and kind. A lookup SHALL return the descriptor for a registered name and SHALL fail explicitly for any other name.

#### Scenario: the eight core types are listed

- **WHEN** the registry is asked for its complete listing
- **THEN** exactly Project, Work, TaskSpace, Asset, Acceptance, Delivery, WorkRun, and Hold are returned, each with its kind

#### Scenario: lookup by name returns the descriptor

- **WHEN** the registry is asked for `Hold` by name
- **THEN** the returned descriptor names `Hold` and its kind

#### Scenario: unknown names fail explicitly

- **WHEN** the registry is asked for a name outside the registered set
- **THEN** the lookup fails with an explicit not-registered error naming the requested name

### Requirement: the registered vocabulary is closed and stable

The registry SHALL expose no path by which a consumer adds, removes, or renames a registered type. Repeated queries over the same registry SHALL return the same set and the same descriptors. The registered set changes only through an accepted specification change, never through registry use.

#### Scenario: repeated queries are identical

- **WHEN** the registry listing is taken twice within one process lifetime
- **THEN** both listings carry the same names, kinds, and order

#### Scenario: consumers cannot mutate the vocabulary

- **WHEN** a consumer obtains a listing or a descriptor
- **THEN** no operation performed through registry queries can add, remove, or rename any entry, and the descriptors handed out cannot be used to alter the registry

### Requirement: interfaces declare shared capability shapes as data

The vocabulary SHALL define the `Assetable` and `Deliverable` interfaces as data. `Assetable` SHALL declare the shared properties every referenceable content carrier commits to — identity, scope, provenance, lifecycle, optional physical-carrier description, and creation timestamp — and SHALL declare the link type constraints every implementer must support, including `derived_from` and `refines`. `Deliverable` SHALL declare the acceptance-linked properties of a deliverable carrier and its required acceptance record constraint. Every link type constraint an interface declares SHALL resolve to a defined link type. Implementing an interface commits a type to the declared shape; it does not transfer values.

#### Scenario: Assetable carries the shared carrier shape

- **WHEN** the `Assetable` interface definition is read
- **THEN** it declares identity, scope, provenance, lifecycle, optional content, and creation-timestamp properties, and declares `derived_from` and `refines` link type constraints

#### Scenario: interface constraints resolve to defined link types

- **WHEN** any interface definition is validated
- **THEN** every link type constraint it declares names a link type that exists in the vocabulary, and validation fails naming the constraint if one does not

#### Scenario: implementing commits to a shape, not to values

- **WHEN** two types both implement `Assetable`
- **THEN** each declares its own additional properties, and neither inherits property values from the interface

### Requirement: link types declare relation shapes as data

The vocabulary SHALL define six link types as data — `depends_on`, `implemented_by`, `contains_clause`, `blocks_delivery`, `derived_from`, and `refines` — each naming its endpoint types, its cardinality, and a semantic description of what the relation means. Every endpoint named by a link type SHALL resolve to a registered core type. `refines` SHALL declare a reverse name so the relation reads in both directions.

#### Scenario: each link type names endpoints and cardinality

- **WHEN** any of the six link type definitions is read
- **THEN** it names its from-type and to-type, states its cardinality, and carries a semantic description

#### Scenario: blocks_delivery names the blocking pair

- **WHEN** the `blocks_delivery` link type definition is read
- **THEN** it names `Hold` as from-type and `Delivery` as to-type with its declared cardinality

#### Scenario: endpoints must resolve

- **WHEN** a link type definition names an endpoint type that is not in the registered vocabulary
- **THEN** validation fails naming the unresolvable endpoint

### Requirement: preset templates provide starting vocabularies as data

The vocabulary SHALL provide two preset templates as data: `software_project` and `generic_project`. A template SHALL contain object type definitions (whose relations consume the defined link types) and interface implementations only. Every relation a template object type declares SHALL reference a defined link type, and every interface it implements SHALL resolve to a defined interface. `generic_project` SHALL contain no domain object types beyond the core vocabulary.

#### Scenario: software_project references resolve

- **WHEN** the `software_project` template is validated
- **THEN** every relation its object types declare resolves to a defined link type, and every interface they implement resolves to a defined interface

#### Scenario: generic_project is core-only

- **WHEN** the `generic_project` template is read
- **THEN** it defines no domain object types beyond the core vocabulary

#### Scenario: templates carry no executable behavior

- **WHEN** any template is read
- **THEN** it contains object type definitions and interface implementations only — no separate action types section, no criteria references, no commands

### Requirement: the submission criteria contract is deterministic and closed

The vocabulary SHALL define the submission criteria contract as data: an action context carrying the actor, the action parameters, and the state versions the evaluation is anchored to; and a result carrying a passed verdict with an optional named reason. The contract SHALL provide `check_actor_permission` as the baseline criteria, evaluating whether the acting participant is registered and authorized for the submission. Authorization follows the kernel's model — participant registration and participant-type gates — and is never derived from the participant's descriptive role. Criteria evaluation SHALL be deterministic — the same context always yields the same verdict — and SHALL not modify any state. The criteria registry SHALL be closed: a criteria reference resolves only to a defined criteria, and an unknown reference is rejected explicitly.

#### Scenario: an unauthorized actor fails with a named reason

- **WHEN** `check_actor_permission` evaluates a context whose actor is unregistered or whose participant type is not authorized for the action
- **THEN** the result is not passed and names the reason

#### Scenario: an authorized actor passes

- **WHEN** `check_actor_permission` evaluates a context whose actor is a registered participant authorized for the action
- **THEN** the result is passed

#### Scenario: evaluation is deterministic

- **WHEN** the same context is evaluated twice
- **THEN** both evaluations yield the same verdict and the same reason

#### Scenario: unknown criteria references are rejected

- **WHEN** a criteria reference names no defined criteria
- **THEN** resolution fails explicitly naming the unknown reference
