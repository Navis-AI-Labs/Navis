# Operations standard

## Runtime configuration

- Configuration is typed, validated once at startup, and separated from secrets. Invalid required configuration stops startup with a safe diagnostic.
- Environment-specific values are injected; source and images remain environment-neutral.
- Services expose distinct liveness, readiness, and dependency diagnostics without leaking secrets or detailed topology.
- Shutdown handles signals, stops intake, drains bounded work, closes resources, and reports incomplete recovery state.

## Service management

- Every production service has owner, service indicators, objectives or explicit best-effort classification, dashboards, alerts, and runbooks.
- Alerts describe user impact or imminent exhaustion, not raw component noise. Every page has an actionable response.
- Capacity, quotas, rate limits, pools, queue depth, storage growth, and third-party limits are monitored.
- Scheduled jobs and maintenance operations are idempotent, observable, resumable, and owned.

## Recovery and incidents

- Recovery objectives are stated for authoritative data and critical workflows. Backup, failover, restore, and degraded mode are exercised.
- Incident response defines severity, command, communication, evidence preservation, mitigation, recovery, and follow-up ownership.
- Post-incident reviews are blameless, evidence-based, and track corrective actions.
- Operational access is least-privileged, audited, time-bounded where possible, and never requires shared credentials.
