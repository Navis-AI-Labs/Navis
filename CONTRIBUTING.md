# Contributing to Navis

Navis uses specification-driven development. The repository is currently building its production foundation; business implementation begins only after its behavior is accepted.

## Read before changing files

1. Read `openspec/project.md`.
2. Read the complete active change under `openspec/changes/`.
3. Read `docs/standards/00-index.md` and every standard selected by its matrix.
4. Read `docs/architecture.md` and the ADRs affected by the change.

## Change sequence

```text
Question and evidence
  -> OpenSpec proposal and scenarios
  -> ADR for material technical choices
  -> maintainer review
  -> implementation and focused tests
  -> full repository validation
  -> acceptance and OpenSpec archive
```

Do not place observable behavior in an engineering standard or implementation choice in an OpenSpec requirement. Use this ownership:

| Content                                      | Location                       |
| -------------------------------------------- | ------------------------------ |
| Project concept and public introduction      | Root `README.md`               |
| Observable requirements and change lifecycle | `openspec/`                    |
| System and code architecture                 | `docs/architecture.md`         |
| Technical choices and alternatives           | `docs/adr/`                    |
| Engineering and production rules             | `docs/standards/`              |
| Production-foundation gates                  | `docs/foundation-readiness.md` |
| Executable implementation                    | Activated workspace units only |

Do not create empty code directories or placeholder README files to represent planned architecture. A workspace unit is created only when an active change gives it executable responsibility, tests, and a verification command.

All source code, technical documentation, ADRs, engineering standards, and OpenSpec artifacts are written in English. The root `README.md` and `README-ZH.md` are bilingual and kept in parity as the project's public entry point. Setup and commands belong here or in development documentation, not in the concept-first root README.

## Validation

After installing the pinned runtime and package manager, run:

```bash
npx --yes pnpm@11.22.0 install --frozen-lockfile
npx --yes pnpm@11.22.0 validate
```

Focused package commands may be used during development, but the full validation gate is required before review.
