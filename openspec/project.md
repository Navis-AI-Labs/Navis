# Navis OpenSpec Context

## Repository role

Navis is a project-centered Human-Agent collaboration system. This repository is self-contained and owns its concept introduction, observable behavior, implementation decisions, engineering standards, source, tests, and release artifacts.

OpenSpec owns proposed and accepted observable behavior. It does not own coding style, generic production practice, or technology selection.

## Documentation ownership

| Content                               | Authority                                                   |
| ------------------------------------- | ----------------------------------------------------------- |
| Project concept and public status     | Root `README.md`                                            |
| Observable requirements and scenarios | `openspec/`                                                 |
| System and code boundaries            | `docs/architecture.md`                                      |
| Technical decisions and alternatives  | `docs/adr/`                                                 |
| Engineering and production rules      | `docs/standards/`                                           |
| Foundation readiness gates            | `docs/foundation-readiness.md`                              |
| Implemented behavior                  | Activated source, runtime contract schemas (Zod), and tests |

## Mandatory context loading

Every task reads:

1. this file;
2. `AGENTS.md` and `CONTRIBUTING.md`;
3. the complete active OpenSpec change;
4. `docs/standards/00-index.md`;
5. every standard selected by the index for the change type;
6. `docs/architecture.md` and affected ADRs.

An OpenSpec design must list its selected standards. An implementation task must name the verification that proves each applicable rule.

## Current phase

The `foundation-baseline` change is archived. It established reproducible repository tooling and business-neutral public contract primitives. It did not authorize business entities, state machines, use cases, runtime services, persistence, queues, user interfaces, or local Agent integration.

The next active change has not been opened. Only a boundary with executable responsibility in an active change may exist in the code tree. Planned architecture remains in `docs/architecture.md`; do not create empty directories or README placeholders.

## Project invariants

- Project continuity belongs to the Project, not to one Agent Session or external task ID.
- Candidate material cannot silently become authoritative Project State.
- Acceptance is accountable and cannot be inferred from executor completion.
- Artifact existence is not Delivery.
- Memory, indexes, and projections are derived and cannot replace authority.
- An Adapter, Worker, Agent runtime, or transport handler cannot directly mutate authority.

Version checks, command identity, aggregate boundaries, event shape, state transitions, and authorization semantics require accepted OpenSpec behavior before implementation.

## OpenSpec lifecycle

```text
proposal -> requirements -> design -> tasks -> review -> implementation -> verification -> archive
```

- Active requirements stay under `openspec/changes/<change>/specs/` and are not current behavior.
- Accepted current behavior belongs under root `openspec/specs/` after review and implementation.
- ADR status does not accept behavior; OpenSpec acceptance does not select an undocumented technology.
- A change that exposes uncertainty records it explicitly instead of resolving it in placeholder code.
