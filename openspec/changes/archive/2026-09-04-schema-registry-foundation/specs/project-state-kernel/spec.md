# project-state-kernel Spec Delta

## ADDED Requirements

### Requirement: the blocks_delivery declaration and the blocking-hold delivery gate are pinned together

The vocabulary's `blocks_delivery` link type declaration and the kernel's blocking-hold delivery gate SHALL be verified against each other: the declaration names `Hold` as from-type and `Delivery` as to-type, and the gate refuses delivery of an asset while a blocking hold is active. A change to one side without the other SHALL fail validation naming the mismatch, so the declared relation and the enforced behavior cannot drift apart silently.

#### Scenario: declaration and gate agree

- **WHEN** the `blocks_delivery` declaration is checked against the delivery gate
- **THEN** the declared endpoints are `Hold` and `Delivery`, and the gate refuses delivery while a blocking hold on the asset is active

#### Scenario: drift fails loudly

- **WHEN** the declaration is altered — renamed, re-endpointed, or removed — while the gate still enforces blocking holds, or the gate stops enforcing while the declaration stands
- **THEN** validation fails naming the mismatch between declaration and behavior
