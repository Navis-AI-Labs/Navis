# ADR-0002: Workspace and TypeScript toolchain

- Status: Proposed
- Date: 2026-08-19

## Context

The repository needs reproducible validation and an enforceable dependency graph before business implementation. It must not turn planned directories into fake workspace packages.

On 2026-08-19, the latest TypeScript release is outside the declared support range of the selected type-aware ESLint parser. An unsupported compiler/parser pair would weaken the quality gate.

## Proposed decision

- Pin Node.js 24 and pnpm 11 in repository metadata and commit the lockfile.
- Use pnpm workspaces. A matching path becomes a workspace unit only when it has a package manifest.
- Use TypeScript 5.9.3 until the type-aware lint toolchain supports a later compiler.
- Enable strict compiler checks from one root base configuration.
- Use TypeScript Project References and `tsc -b` while the dependency graph remains small and has no separate task-cache owner.
- Use ESLint with type-aware TypeScript rules, Prettier, Vitest with coverage, and dependency-cruiser.
- Keep root `tsconfig.json` as a solution file. Each activated TypeScript workspace unit owns one build config and may add a test config only when tests require a different source boundary.
- Activate only `@navis/contracts` in the foundation baseline.

## Consequences

The toolchain checks a real boundary without giving every planned module repeated configuration. TypeScript is intentionally not the registry's newest version; compatibility is reviewed before upgrades.

If a task graph or cache tool is adopted later, a new ADR must decide whether it replaces Project References as build-order owner.

## Alternatives

- **Latest TypeScript with an unsupported parser:** rejected because lint behavior would be outside declared support.
- **Turborepo or Nx immediately:** deferred until task volume and measurements justify another orchestration owner.
- **One root TypeScript project:** rejected because independent compilation boundaries cannot be proven as the repository grows.
- **Shared configuration package:** rejected while configuration has only one repository consumer.
