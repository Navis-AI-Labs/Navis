# Errors and observability standard

## Error model

- Errors are classified at the boundary that owns them. Domain, Application, transport, and Infrastructure failures are not collapsed into one generic exception.
- Public HTTP failures follow `06-contracts-and-compatibility.md`. Machine identifiers are stable; clients do not parse human detail.
- Catch only when adding context, translating a boundary, compensating, or terminating safely. Preserve the original cause.
- Never expose stack traces, query text, credentials, tokens, filesystem paths, dependency internals, or unredacted payloads to clients.
- Retryability is explicit and based on semantics. An unknown failure is not automatically retryable.

## Telemetry

- Logs are structured events with stable names and fields. Correlation fields flow from request or job entry to downstream operations.
- Distributed tracing uses W3C Trace Context. A request ID correlates one request but does not replace a trace ID.
- Metrics describe service behavior and saturation. Labels are bounded; user IDs, resource IDs, raw paths, prompts, and error messages are not labels.
- Telemetry records outcomes and durations at boundary crossings without duplicating sensitive payloads.
- Log level has operational meaning: debug for development detail, info for lifecycle facts, warn for recoverable abnormal conditions, and error for failed outcomes requiring attention.

## Audit separation

Operational logs and business audit records are separate data products. Audit records are append-oriented, attributable, scoped, integrity-protected, and governed by explicit retention. A log line, trace span, or executor claim cannot serve as business acceptance.

## Verification

Tests prove public error mapping, redaction, correlation propagation, bounded metric cardinality, and audit creation for protected mutations. Dashboards and alerts link to an owner and runbook before production release.
