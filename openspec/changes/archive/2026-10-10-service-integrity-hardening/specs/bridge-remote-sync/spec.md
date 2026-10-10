## ADDED Requirements

### Requirement: device management is scoped to the authenticated participant

Device listing and revocation SHALL require a valid device credential. Revocation SHALL be authorized only when the target device belongs to the authenticated participant. Missing and foreign-owned targets SHALL receive the same authorization denial without mutating the target or its keys. No implicit administrative privilege SHALL be granted by project membership.

#### Scenario: a foreign or missing target is denied

- **WHEN** an authenticated participant requests revocation of a foreign-owned or missing device
- **THEN** the service returns HTTP 403 with `device-auth/authorization-denied`
- **AND** the foreign device and its keys remain unchanged

#### Scenario: missing or invalid credentials cannot look like success

- **WHEN** a device-management request lacks a valid credential or carries a revoked key
- **THEN** the service returns HTTP 401 with the corresponding existing authentication token

#### Scenario: an owner revokes a device

- **WHEN** the authenticated participant revokes their own registered device
- **THEN** revocation succeeds and that device's key stops authenticating immediately
- **AND** a repeated revocation authorized by another live device of the same participant remains successful
