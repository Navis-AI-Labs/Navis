# Dependencies and supply-chain standard

## Admission

- A dependency is added only for a concrete capability with named consumers and comparison against the platform or existing code.
- Review maintenance, ownership, license, security history, transitive size, runtime permissions, module format, engines, and exit cost.
- Runtime dependencies receive stricter review than development dependencies. Frameworks, ORMs, identity libraries, cryptography, workflow engines, and telemetry SDKs require an ADR.
- Do not wrap a mature standard library unless the wrapper creates policy, compatibility, isolation, or a meaningful test boundary.

## Reproducibility

- Package manager and runtime are pinned. The lockfile is committed, and CI uses frozen installation.
- Dependency ranges follow release policy; release artifacts resolve to an immutable graph.
- Install scripts, native binaries, generators, and downloaded executables are explicitly reviewed and minimized.
- Generated files are deterministic from committed inputs and checked for drift.

## Security and maintenance

- Automated vulnerability, license, secret, and malicious-package checks run in CI. Findings have owner and response deadline based on severity and exposure.
- Releases produce inventory and provenance sufficient to trace an artifact to source and build inputs.
- Updates are small and regular. Major upgrades include compatibility, performance, migration, and rollback evidence.
- Abandoned or compromised dependencies have a removal or containment plan.
