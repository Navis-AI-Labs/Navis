# Security standard

## Design requirements

- Every externally reachable feature has a threat model covering assets, actors, trust boundaries, abuse cases, and residual risk.
- Authentication establishes identity; authorization evaluates action, resource, scope, and current policy. Deny is the default, and every protected operation enforces authorization server-side.
- External data is untrusted regardless of source. Validate structure, size, encoding, content type, path, URL, and semantic limits before use.
- Privileges, tokens, credentials, network access, filesystem access, and data exposure are minimized per component.
- Security-sensitive operations are explicit, auditable, rate-limited where abuse is possible, and fail closed when policy cannot be evaluated.

## Secrets and data

- Secrets never enter source, committed configuration, browser storage, URLs, telemetry, error detail, fixtures, or build artifacts.
- Secret access uses an approved provider, supports rotation, and is scoped to the smallest runtime identity.
- Sensitive and personal data has an owner, purpose, retention period, deletion path, access policy, and redaction rule before persistence.
- Encryption in transit is required outside a process trust boundary. At-rest and field-level protection follow the threat model.
- Upload, import, archive, URL-fetch, and file-path features defend against traversal, decompression bombs, SSRF, injection, confused-deputy access, and unsafe content handling.

## Secure delivery

- Dependencies, containers, and release artifacts follow `09-dependencies-and-supply-chain.md` and `11-ci-and-release.md`.
- Security controls have negative tests. Authorization tests prove cross-scope isolation, not only successful access.
- Critical findings block release unless a time-bounded exception with compensating controls is approved.
- Security incidents have an owner, evidence-preservation process, rotation path, impact assessment, and post-incident review.
