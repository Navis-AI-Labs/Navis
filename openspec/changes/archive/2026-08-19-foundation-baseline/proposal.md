# Production Foundation Baseline

## Problem

Navis needs a trustworthy development base before business behavior is known. Without a strict workspace gate and common wire-contract profile, contributors would invent incompatible response envelopes, error shapes, validation, trace correlation, package layouts, and quality commands inside future features.

Creating every planned application, service, and package now would be equally harmful: placeholder code would freeze names and dependencies without executable responsibility.

## Proposal

Establish the smallest production foundation with current consumers:

- a pinned Node.js and pnpm workspace toolchain;
- strict TypeScript, format, lint, dependency, test, coverage, build, and OpenSpec gates;
- one activated `@navis/contracts` workspace unit;
- business-neutral request-context, JSON success, cursor pagination, and RFC 9457 error schemas.

## Affected scope

- Root toolchain and quality configuration.
- `packages/contracts` as the only activated source boundary.
- Architecture, ADRs, engineering standards, and foundation-readiness documentation.
- OpenSpec context and this active change.

## Non-goals

This change does not create or implement Domain, Application, Infrastructure, Web, API, Worker, persistence, identity, workflow, local integration, or any Project business object. It does not choose runtime frameworks or vendors.

## Exit criteria

1. A clean install can run the full validation gate without global tooling.
2. Runtime schemas, inferred types, and tests agree.
3. The filesystem contains no placeholder code boundary or stale prior implementation.
4. ADR-0001 through ADR-0004 are ready for maintainer acceptance, revision, or rejection.
5. Business implementation remains blocked pending a separate accepted change.
