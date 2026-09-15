# asset-strength Specification

## Purpose

> **Capability intent** — Asset retirement must be driven by a structured retention signal instead of human memory alone. This capability defines strength as a read-only runtime evaluation over projection-derivable reference edges: a score in `[0.0, 1.0]` expressing how useful an asset has been since its acceptance anchor, feeding retirement **suggestions** that always require human confirmation through the reason-gated asset transition command. Strength answers whether an asset still earns its retention — it never re-judges whether the asset was trustworthy when accepted.
> **Scope boundary** — This capability defines only: the evaluation contract and score range; the single baseline signal derived from projection-derivable reference edges; the observation floor; suggestion generation as data with mandatory human confirmation; the orthogonality boundary against acceptance-time quality. Not included: automatic execution of any lifecycle transition, signal-model tuning beyond the baseline (experiment-gated), quality or refinement judgments, any write path from a suggestion directly to a terminal state, and any persistence of evaluations to the ledger (evaluations are read-path outputs, not events).

## Requirements

### Requirement: strength is a deterministic read-path evaluation over projection-derivable reference edges

Asset strength SHALL be a read-only evaluation of the projection: the asset row, its acceptance anchor (the created-at timestamp of its `accepted` acceptance row), and the reference edges derivable from the projection — deliveries consuming the asset (delivery rows keyed by the asset) and holds referencing it (the asset's membership in hold reference lists). The score SHALL be in the closed range `[0.0, 1.0]`, and the evaluation SHALL be deterministic: the same projection state always produces the same score. Reference consumption counts edges created after the acceptance anchor, weighted by logical recency: an edge contributes by how close its creation time is to the evaluation point on the projection's own logical timeline — never a wall clock — so an asset whose references have gone stale sees its score decline while the same projection state still yields the same score. Observed-work volume counts works created after the anchor.

#### Scenario: same projection state produces the same score

- **WHEN** the evaluation runs twice over identical projection state
- **THEN** both runs return the identical score within the closed range `[0.0, 1.0]`

#### Scenario: the baseline signal derives only from projection-derivable reference edges

- **WHEN** the evaluation runs with the baseline signal set
- **THEN** the score derives from the count of projection-derivable reference edges created after the acceptance anchor — deliveries consuming the asset and holds referencing it — and no other signal contributes

#### Scenario: not-yet-accepted assets evaluate without an anchor

- **WHEN** an asset has no accepted acceptance row
- **THEN** the evaluation runs with the acceptance anchor at asset creation, so candidate-stage assets can be evaluated without inventing an anchor

### Requirement: the observation floor prevents premature suggestions

The evaluation SHALL incorporate an observation floor: until the observed-work volume since the acceptance anchor reaches the floor, the score SHALL be the neutral baseline regardless of reference count. Absence of evidence is not evidence of uselessness — the floor keeps brand-new or newly-accepted assets from reading as low-strength. The accepted defaults are an observation floor of 3 observed works, a suggestion threshold of 0.2, and a neutral baseline of 0.5 — evaluation-contract constants of this baseline signal, tunable only by a later accepted change.

#### Scenario: below the floor the score is neutral regardless of references

- **WHEN** the observed-work volume since the anchor is below the floor
- **THEN** the score is the neutral baseline even at zero reference edges, and no suggestion is shaped

#### Scenario: at or above the floor references drive the score

- **WHEN** the observed-work volume since the anchor meets or exceeds the floor
- **THEN** the reference-edge count drives the score, rising toward the upper end as edges accumulate

#### Scenario: absent usage observations do not prove disuse

- **WHEN** the work floor is met but the asset has no observable post-anchor reference edges
- **THEN** the score remains the neutral baseline and no retirement suggestion is produced, because the baseline does not observe all forms of asset use

#### Scenario: shifting the calendar does not change relative recency

- **WHEN** every timestamp in a valid evaluation is shifted by the same duration
- **THEN** its score and suggestion are unchanged

#### Scenario: stale references decline and the threshold is reachable

- **WHEN** two assets above the floor have equal reference-edge counts, but one's edges were all created near the evaluation point and the other's all far from it on the projection's logical timeline
- **THEN** the recently referenced asset scores higher, and the stale-referenced asset's score can fall below the suggestion threshold — retirement suggestions are reachable for formerly useful assets, not only new ones

### Requirement: strength can only suggest retirement, and a human must confirm

A low strength score MAY cause the system to shape a retirement suggestion — a data payload naming the asset, the score, the signals that produced it, and the recommended terminal state. The suggestion SHALL exist only as the evaluation's read-path output: it is not persisted, not appended as an event, and it SHALL require explicit human confirmation through the reason-gated human-only asset transition command before any lifecycle change. No command path MAY execute a terminal transition (`deprecated`, `archived`, `purged`) automatically as a consequence of a strength evaluation.

#### Scenario: low score produces a suggestion, not a transition

- **WHEN** an asset's strength score falls below the suggestion threshold at or above the observation floor
- **THEN** the evaluation shapes a retirement suggestion carrying the score and its signals, the ledger and projection are unchanged, the asset's lifecycle is unchanged, and acting on the suggestion means a human executes the reason-gated transition command

#### Scenario: strength never executes a terminal transition

- **WHEN** a strength evaluation completes, whatever the score
- **THEN** no command path has moved the asset to `deprecated`, `archived`, or `purged` as a consequence of the evaluation alone, and no suggestion payload has been persisted to the ledger

#### Scenario: suggestion shapes only for transitionable assets

- **WHEN** the evaluated asset is not in a lifecycle state from which the recommended transition is legal
- **THEN** no retirement suggestion is shaped for that asset, while the evaluation still computes and returns the score

### Requirement: strength stays orthogonal to acceptance-time quality

Strength SHALL express retention consequence only — whether an asset still earns its place after acceptance. It SHALL NOT be used as a quality judgment, SHALL NOT participate in acceptance decisions, and SHALL NOT drive refinement relationships between assets. A high score does not re-validate an asset; a low score does not invalidate the acceptance that admitted it.

#### Scenario: an accepted asset with a low score keeps its acceptance

- **WHEN** an asset that passed acceptance accumulates a low strength score
- **THEN** its acceptance record and lifecycle state remain valid, and the score's only effect is the suggestion path above

#### Scenario: a high score does not re-validate

- **WHEN** an asset with a superseding or rejecting acceptance history accumulates a high strength score
- **THEN** no acceptance record is re-validated and no superseded or rejected lifecycle state is changed by the evaluation
