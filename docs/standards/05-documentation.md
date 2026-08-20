# Documentation standard

## Ownership

- The root README is concept-first: what Navis is, its value chain, distinctions, non-goals, and current status.
- OpenSpec owns observable requirements and scenarios. ADRs own technical decisions and alternatives. Standards own engineering rules. Architecture owns planned and active boundaries.
- Documentation does not depend on local absolute paths or another checkout to make this repository understandable.
- Every document states status when a reader could confuse a proposal with an accepted or implemented fact.
- Code directories do not receive placeholder README files merely to visualize future structure.

## Code documentation

- Public exports have concise TSDoc describing contract, units, failure, side effects, concurrency, and compatibility where relevant.
- Comments explain why a constraint exists. Details that can drift are verified by code or tooling instead of prose.
- Examples compile or are exercised by tests. Example credentials, hosts, identifiers, and payloads are clearly non-production.
- Generated schema and API references identify their source and generation command.

## Maintenance

- A behavior change updates OpenSpec and user-facing documentation in the same change.
- A boundary or public export change updates architecture and compatibility notes.
- A material technical decision adds or supersedes an ADR; historical ADRs are not rewritten to hide prior reasoning.
- Documentation links and generated artifacts are checked in CI. Stale setup commands and unsupported versions block release.
