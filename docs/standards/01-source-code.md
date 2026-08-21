# Source code standard

## Architecture and ownership

- Code lives in the boundary that owns its decision. Transport mapping, use-case orchestration, business policy, and external adapters remain separate concerns.
- A workspace package represents a real dependency, compilation, deployment, publication, permission, or ownership boundary. Ordinary modules do not receive `package.json` or `tsconfig.json`.
- Package internals are organized by capability and then by use case when more depth is needed. A flat `src` root and a generic `utils` directory are rejected as architecture.
- Dependencies follow `docs/architecture.md`. A composition root may depend inward; an inner boundary never imports a concrete outer implementation.
- Public exports are explicit. Broad barrel exports may not make an unstable internal tree public.

## Code philosophy

Defaults with documented boundaries. Deviate only with a comment explaining why.

1. Simplicity over premature complexity. Choose the simplest correct solution. Do not add abstraction until a concrete requirement demands it (YAGNI). Simplicity is not an excuse for missing error handling or edge cases — those are correctness.
2. DRY — single authoritative source, not "never duplicate." Every piece of knowledge (concept, regex, schema, type, rule) has one authoritative definition; consumers import it. Zod schemas are the single source of truth; TypeScript types are inferred (`z.infer`), never hand-written in parallel. Comments explain why — constraints, tradeoffs, invariants — not what the code does. Boundary: duplication is cheaper than the wrong abstraction (Sandi Metz). Apply the Rule of Three: extract only when a pattern appears in three or more independent call sites. If extraction creates false coupling, document the intentional duplication.
3. Composition over inheritance. Prefer `implements` + composition over `extends`. Interfaces define capabilities; objects delegate without inheriting a parent's entire surface. Boundary: inheritance is acceptable only for genuine is-a hierarchies satisfying Liskov Substitution — rare in domain modeling; when in doubt, compose.
4. Explicit over implicit. Signatures describe inputs, outputs, and failure modes. Hidden side effects, magic values, and implicit lifecycle hooks are forbidden. Boundary: do not over-specify trivial operations — explicitness targets contracts and failure modes, not `validateString` returning `boolean`.
5. Immutable by default. Prefer `readonly`, `const`, and pure functions. Mutation is local, intentional, and behind an owning abstraction. Boundary: for hot paths on large collections, local mutation behind a clean API is acceptable — callers still see an immutable return value.

## TypeScript baseline

- Production TypeScript uses the repository strict compiler baseline, including unchecked-index, exact-optional-property, implicit-return, override, and unknown-catch checks.
- Use `unknown` at untrusted boundaries and narrow it with a runtime schema. `any` requires a documented, narrow interop reason and may not escape that adapter.
- Prefer immutable values and readonly contracts. Mutation is local, intentional, and hidden behind an owning abstraction.
- Public functions, exported constants, and port methods have explicit inputs and outputs. Types describe failure and absence rather than relying on comments.
- Handle finite variants exhaustively. An unhandled state fails checking or raises an explicitly classified internal error.
- Promises are awaited, returned, or deliberately supervised. Floating promises and unbounded background work are forbidden.
- Module initialization is deterministic and side-effect free. Do not create clients, read environment variables, or start timers during import.

## Naming and files

- TypeScript files use `kebab-case`; exported type and class names use `PascalCase`; variables and functions use `camelCase`; wire names follow their contract.
- One file owns one cohesive concept. Names such as `types.ts`, `helpers.ts`, `common.ts`, and `validation.ts` are not used as cross-capability dumping grounds.
- Generated code is isolated, reproducible, and marked as generated. Handwritten code never edits generated output.
- Comments explain constraints, tradeoffs, or non-obvious safety behavior. They do not narrate syntax.

## Review evidence

Every source change provides focused tests and passes format, lint, type, dependency-boundary, and build checks. A boundary change includes the before/after import graph and updates architecture documentation.
