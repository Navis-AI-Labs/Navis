# ADR-0001: Repository dependency direction

- Status: Proposed
- Date: 2026-08-19

## Context

Navis needs visible long-term ownership without placing unresolved business behavior in source files. A flat application would hide boundaries; a package for every architectural noun would create configuration without real isolation.

## Proposed decision

Use four shared boundaries and three deployable boundaries when their first responsibilities are accepted:

```text
domain + contracts <- application <- infrastructure <- api / worker
web -> contracts
```

The precise import rules are:

- Domain imports no other Navis package.
- Contracts imports no server implementation package.
- Application may import Domain and Contracts and owns output ports.
- Infrastructure may import Application, Domain, and Contracts to implement ports.
- API and Worker are composition roots and may import Contracts, Application, and Infrastructure.
- Web may consume public Contracts but not server implementation packages.

Local integration and public clients interact through public contracts. Their implementations are not represented as placeholder packages.

## Consequences

Business policy remains independent of transport and storage. Public contracts remain consumable without server internals. An automated import gate becomes mandatory as each source boundary is activated.

Only Contracts is activated by the foundation change. This ADR does not authorize other packages or business code.

## Alternatives

- **One backend package:** less configuration, but no enforceable dependency direction.
- **Package per capability or cross-cutting concern:** useful after independent consumers or ownership exist; premature now.
- **Feature modules only inside one service:** useful for service-local behavior but insufficient for framework-independent policy and public contracts.
