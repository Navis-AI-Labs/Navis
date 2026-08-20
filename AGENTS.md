# Navis Agent Instructions

Navis is a self-contained, specification-driven repository. The root README defines the project concept; OpenSpec owns observable behavior and change state; ADRs own technical decisions; engineering standards own implementation rules.

## Required context

Before any change:

1. Read `openspec/project.md`.
2. Read the complete active OpenSpec change.
3. Read `docs/standards/00-index.md` and all standards selected for the change type.
4. Read `docs/architecture.md` and affected ADRs.

## Current phase

The repository is establishing architecture and production foundations. Only code explicitly admitted by an active OpenSpec change may exist. Do not create placeholder apps, services, packages, domain models, ports, adapters, framework bootstraps, or README-only code directories.

## Boundaries

- Observable behavior and invariants belong in OpenSpec.
- Engineering practice belongs in `docs/standards/`.
- Material implementation choices belong in `docs/adr/`.
- Planned code structure belongs in `docs/architecture.md` until it has an approved executable responsibility.
- Public transport contracts must remain independent of server implementation types.
- No Adapter, Worker, Agent runtime, or transport handler may bypass the future Application and Domain authority boundaries.

Every implementation task must name its accepted requirement, applicable standards, affected workspace unit, and verification command.
