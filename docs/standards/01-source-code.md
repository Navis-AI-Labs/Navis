# Source code standard

## Architecture and ownership

- Code lives in the boundary that owns its decision. Transport mapping, use-case orchestration, business policy, and external adapters remain separate concerns.
- A workspace package represents a real dependency, compilation, deployment, publication, permission, or ownership boundary. Ordinary modules do not receive `package.json` or `tsconfig.json`.
- Package internals are organized by capability and then by use case when more depth is needed. A flat `src` root and a generic `utils` directory are rejected as architecture.
- Dependencies follow `docs/architecture.md`. A composition root may depend inward; an inner boundary never imports a concrete outer implementation.
- Public exports are explicit. Broad barrel exports may not make an unstable internal tree public.

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
