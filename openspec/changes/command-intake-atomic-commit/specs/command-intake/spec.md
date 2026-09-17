## ADDED Requirements

### Requirement: Postgres intake commits claim and ledger atomically

When the Postgres adapter backs the inbox, the dispatch composition NONE SHALL leave a fetched claim mid-flight after a crash: begin, the executor's writes, and complete SHALL run inside one PostgreSQL transaction produced by the transaction-bound intake composition. If the executor or the transaction itself fails, the whole presence SHALL roll back — no claim, no stored outcome, no partial ledger — and a retry with the same key SHALL be treated as fresh again. The in-memory adapter is outside this guarantee; it SHALL remain unchanged and SHALL be documented as R0's non-transactional variant.

The transaction-bound composition SHALL NOT widen the `CommandInbox` port: it SHALL provide a Postgres-specific callable that takes the current request and executor and returns the same dispatch response type as the free dispatch use case.

#### Scenario: crash during execute rolls everything back

- **WHEN** a submission with a new key is begun and the executor throws before the commit point under the Postgres transactional composition
- **THEN** the database has neither a claim row nor a stored outcome for that key, and a retry begins as `fresh`

#### Scenario: success commits the claim and outcome together

- **WHEN** the executor succeeds under the Postgres transactional composition
- **THEN** the claim row and the stored outcome become visible atomically on commit, and a retry replays the stored outcome without re-executing

#### Scenario: the guarantee does not reach across adapter boundaries

- **WHEN** the same sequence runs against the in-memory adapter
- **THEN** the claim remains `processing`-visible until completed, because the in-memory adapter is deliberately not transactional in R0
