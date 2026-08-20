# Concurrency and reliability standard

## Concurrency

- Every mutable authority defines its consistency model, conflict behavior, and transaction boundary.
- Optimistic version checks or locks are explicit at the owner. Last-write-wins is not used where conflicting intent requires review.
- Idempotency scope, identity, payload equivalence, retention, replay result, and concurrent duplicate behavior are part of the operation contract.
- In-process locks are never treated as distributed coordination. Coordination uses a mechanism matching the deployment and failure model.

## Timeouts, retries, and cancellation

- Every external call has a timeout budget derived from the caller deadline. Cancellation propagates where supported.
- Retries require transient classification, bounded attempts, exponential backoff, jitter, and an idempotent or deduplicated effect.
- Unknown outcomes for non-repeatable side effects are recorded and reconciled, not blindly retried.
- Retry storms are controlled through budgets, backpressure, concurrency limits, and circuit or load-shedding policy where justified.

## Messaging and background work

- Delivery semantics are documented as at-most-once, at-least-once, or effectively-once within a stated boundary. Exactly-once is not claimed without proof.
- Handlers validate version and scope, deduplicate where required, and make acknowledgement ordering explicit.
- Poison messages have a bounded failure path, retained diagnostics, redaction, and operator action. Dead-letter storage is not silent data loss.
- Shutdown stops intake, drains or checkpoints bounded work, and leaves recoverable ownership.

## Verification

Tests exercise concurrent duplicates, stale writers, timeout, cancellation, termination, dependency outage, redelivery, reordering, partial effects, and recovery. Reliability claims require fault-injection evidence at the selected runtime boundary.
