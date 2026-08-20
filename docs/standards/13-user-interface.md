# User interface standard

## Boundaries

- Browser code consumes public contracts and does not import server Domain, Application, or Infrastructure implementations.
- Authorization is enforced by the service. Hidden or disabled controls are usability behavior, not security controls.
- Server state, local interaction state, draft state, and cached state have explicit owners. Optimistic updates define conflict and rollback.

## Accessibility and interaction

- User workflows meet WCAG 2.2 AA expectations: semantic structure, keyboard operation, visible focus, accessible names, contrast, zoom, reduced motion, and screen-reader status.
- Every asynchronous surface has stable loading, empty, error, denied, stale, retry, and success states.
- Destructive or externally visible actions communicate scope and outcome and require confirmation proportional to reversibility.
- Focus, selection, scroll, and draft content remain predictable across navigation and live updates.

## Performance and resilience

- Initial load, interaction latency, layout stability, asset size, and long-task budgets follow `10-performance-and-resources.md`.
- Network requests are cancelable where appropriate, deduplicated, bounded, and resilient to stale responses.
- Sensitive data is not persisted in browser storage or telemetry without an explicit security decision.

## Verification

Component tests prove state behavior; contract tests prove mapping; end-to-end tests cover critical workflows. Automated accessibility checks are supplemented by keyboard and assistive-technology review for release-critical flows.
