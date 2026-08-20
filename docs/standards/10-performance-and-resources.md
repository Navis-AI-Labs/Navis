# Performance and resource standard

## Budgets

- User-facing and background paths define measurable latency, throughput, payload, memory, CPU, storage, and concurrency budgets before production release.
- Budgets use representative percentiles and workload shapes. Averages alone are insufficient.
- No performance number is promised without a reproducible environment, data volume, concurrency model, and measurement date.

## Design

- Work is bounded by input size, pagination, batching, concurrency, and deadlines. Unbounded reads, queues, caches, recursion, and fan-out are forbidden.
- Large payloads are streamed or referenced rather than repeatedly copied. Backpressure is preserved across streaming boundaries.
- Caches define key cardinality, size, TTL, invalidation, consistency, and failure behavior before use.
- Expensive parsing, validation, serialization, compression, and cryptography are measured with representative payloads.
- Optimization does not weaken correctness, authorization, audit, or data-isolation rules.

## Verification

Critical paths have repeatable benchmarks or load tests with regression thresholds. Production telemetry reports budget indicators and saturation. Capacity limits, scale triggers, and overload behavior are documented before launch.
