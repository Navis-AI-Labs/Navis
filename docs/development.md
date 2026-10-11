# Development workflow

## Document and code ownership

| Question                                           | Location                                      |
| -------------------------------------------------- | --------------------------------------------- |
| What Navis is                                      | Root `README.md`                              |
| What behavior must be observable                   | OpenSpec requirements and scenarios           |
| How a change moves from proposal to implementation | Active OpenSpec change                        |
| Which boundary owns a responsibility               | `docs/architecture.md`                        |
| Why a technical choice was made                    | `docs/adr/`                                   |
| How production code must be engineered             | `docs/standards/`                             |
| Which foundations are ready                        | `docs/foundation-readiness.md`                |
| What behavior actually runs                        | Source and tests in activated workspace units |

Code directories do not carry placeholder README files. A package manifest, explicit exports, tests, and generated contract artifacts document an activated code boundary; the architecture document records planned boundaries.

## Verification environment

Use Node.js 24.19.0 and pnpm 11.22.0 from `package.json` and CI. Package metadata and CI define the required versions. Check the Node and pnpm executables selected by runtime-manager shims before validation.

For a run without PostgreSQL, remove `DATABASE_URL` from the test process environment. Integration suites treat an empty or whitespace-only value as unconfigured, while API startup rejects a supplied invalid database URL. A full validation run requires an explicitly identified disposable PostgreSQL 15 database; the suites apply migrations and leave test rows behind. Skipped database suites are not release evidence. Run `DATABASE_URL=postgres://... pnpm validate`, followed by `pnpm dependencies:audit`. Do not pass an empty connection string directly to the driver, which can select a default local database.

Tests and coverage measure their selected sources. A process-entry smoke test, a built-package installation check, and a client-to-service contract test are separate evidence. Preserve a running checkout's build artifacts when investigating which version it executed.

## OpenSpec flow

1. Create or update a change under `openspec/changes/<change-id>/`.
2. Define the problem and non-goals in `proposal.md`.
3. Define observable requirements in `specs/<capability>/spec.md`.
4. Explain ownership, alternatives, selected standards, and unresolved decisions in `design.md`.
5. List ordered work and verification in `tasks.md`.
6. Obtain review before business implementation.
7. Implement only the accepted scope and keep task status current.
8. Validate, review, move accepted behavior to root specs, and archive the change.

OpenSpec does not store coding style or generic production practice. Its context file routes contributors to `docs/standards/00-index.md`, and each design names the standards that apply.

## Activating a workspace unit

Before creating a package, application, or service, the active change must identify:

1. accepted executable responsibility;
2. concrete consumers;
3. allowed and forbidden dependencies;
4. public exports or process entry points;
5. build and test boundaries;
6. ownership, deployment, publication, or trust reason;
7. applicable standards and verification;
8. accepted ADRs for material technology.

Only the workspace-unit root owns `package.json` and `tsconfig.json`. Internal capability directories own neither.

## Foundation-first rule

Before business code enters an activated boundary, complete the applicable rows in `docs/foundation-readiness.md`. For example, a service cannot add a business handler before configuration validation, public error mapping, telemetry, graceful shutdown, health checks, and service tests exist for the selected runtime.

This rule does not justify unused framework packages. A foundation is built with its first real consumer, then reused when a second consumer proves a stable shared boundary.

## Review evidence

Every implementation change reports:

- accepted OpenSpec requirements implemented;
- ADRs applied or added;
- standards selected from the matrix;
- affected dependency graph;
- commands run and results;
- generated artifacts changed;
- compatibility and migration classification;
- residual risk and deferred foundation work.

## Supported hosts

Use the pinned Node 24 and pnpm 11 toolchain on Windows, macOS or Linux. Windows and macOS run the server through Docker Desktop in Linux-container mode; Linux uses Docker Engine with Compose. The server image has the same Linux runtime on every host. Native CLI/Bridge processes use the host's Node runtime, per-user storage and IPC implementation.

Run repository commands through pnpm. In particular, `pnpm instance install-client` supplies the package-manager executable without requiring a Unix shell on Windows. The generated launcher is `.local/bin/navis` on macOS/Linux and `.local/bin/navis.cmd` or `.local/bin/navis.ps1` on Windows. The ASCII CMD entry delegates to a UTF-8 BOM PowerShell launcher so non-ASCII installation paths work with Windows PowerShell 5.1. These files are generated for the current installation and are not committed or copied from another developer's machine. Installed runtime files are independent of workspace rebuilds; update them through an explicit reinstall.

Unix private state uses owner-only permissions; Windows uses native ACLs for private directories and credential validation. Different `NAVIS_HOME` profiles use separate endpoints, including Windows named pipes. Generated data, credentials, launchers and backups remain outside Git. Each installation creates its own secrets; none are built into the image.

Source lint resolves public workspace entries directly from source through `tsconfig.tooling.json`. It does not require generated declarations to be current. Production exports still refer to built artifacts; run `pnpm build` before executing or installing packages.

## Headless local instance

The supported profile runs the API on `http://127.0.0.1:8080` and runs PostgreSQL in its own Compose service with a named persistent volume. Source code and `node_modules` from the checkout are not mounted into the API container. Use the pinned Node/pnpm toolchain for repository commands.

Get the source and install its frozen dependencies before following the configuration steps below:

```bash
git clone https://github.com/Navis-AI-Labs/Navis.git
cd Navis
pnpm install --frozen-lockfile
```

The CLI and skill are currently installed from source; standalone release packages are not published. Use a source revision that includes the local-instance runtime and installation scripts.

### Compose, containers and processes

`docker-compose.yml` defines one project with two services, `api` and `postgres`. `pnpm instance up` invokes Compose to build and start them. Docker Desktop lists both containers under the Navis project. Each container has its own logs, health and restart policy.

`navis` is the Compose project/group, not a third container. Generated container names follow `<project>-<service>-<replica>`: `navis-api-1` and `navis-postgres-1` are the first instances of the two services. The suffix is an instance number, not a version or an error. Keep these generated names; operational commands address `api` and `postgres` by service name. No custom `container_name` is needed.

| Component                       | Runs in              | Startup owner                                                                  |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| PostgreSQL                      | `postgres` container | Its image initializes a fresh data directory or reuses the persistent database |
| API                             | `api` container      | Compose starts it after PostgreSQL is healthy                                  |
| Model assistance worker         | API process          | API starts it when model configuration is supplied                             |
| Bridge daemon and SQLite Outbox | Client machine       | CLI starts or reuses the selected profile's daemon                             |
| CLI                             | Client machine       | One process for each user or hook invocation                                   |

There is no separate deployed Worker in this profile; Web remains planned. Inspect the services and database from the checkout with:

```bash
pnpm instance status
docker compose --env-file .local/runtime.env logs --tail 100 api
docker compose --env-file .local/runtime.env logs --tail 100 postgres
docker compose --env-file .local/runtime.env exec -T --user postgres postgres pg_isready -h 127.0.0.1 -U navis -d navis
```

A PostgreSQL log saying `Skipping initialization` means it is reusing its existing data directory. It still starts the database; `ready to accept connections` indicates readiness. `pnpm instance restart` restarts the API only. Use `docker compose --env-file .local/runtime.env restart postgres` when intentionally restarting the database. Do not remove the volume as a restart procedure.

### Health probes and access logs

Docker checks API readiness every 30 seconds with a 5-second health-command timeout, three failures before unhealthy status and a 60-second startup grace period. Startup probes may run more frequently until the service first becomes healthy. PostgreSQL has its own 10-second readiness probe. These are deployment defaults; shorter readiness intervals may be appropriate for an orchestrator with tighter traffic-routing objectives.

Successful `/healthz` and `/readyz` requests produce debug logs, so they do not fill the default info log. Set `NAVIS_API_LOG_LEVEL=debug` and recreate the API for probe diagnostics. Failed probes keep their status, correlation and error logging. Ordinary business requests retain info logging.

`/healthz` reports API process liveness; `/readyz` checks the database with a short deadline. A database outage makes readiness return 503 while the API remains running and can recover its connections. Compose's dependency check gates initial startup; Docker does not restart a still-running container solely because its health status becomes unhealthy. The configured restart policies handle process exits.

### Operational logs and business audit

Applications write operational events to stdout/stderr; Docker owns collection and rotation. The API emits structured JSON, including safe startup/shutdown and failure outcomes. PostgreSQL uses its native stderr logging. The Compose profile uses Docker's `local` driver, with a 10m segment limit, three retained segments per container and compression. Use `docker compose logs` or Docker Desktop to read these logs, rather than opening Docker's internal log files.

| Record                                                                 | Default handling                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Successful liveness/readiness probe                                    | DEBUG; omitted at the default INFO level                                            |
| API startup/shutdown and successful business requests                  | Safe INFO summaries                                                                 |
| Rejected operations and failed requests/probes                         | WARN/ERROR with status and correlation                                              |
| PostgreSQL failures                                                    | Error summaries; no default statement, parameter or failing-row DETAIL/CONTEXT dump |
| Credentials, model keys, request bodies, prompts and generated content | Excluded from application operational logs                                          |
| Project authority and business audit                                   | Persisted in their database stores independently of log rotation                    |

Operational log retention is bounded. Rotation or container removal can discard old operational logs; it does not remove project events or audit rows. Long-term searchable retention and alerting require an operator-owned log collection service with an explicit retention/access policy before a broader production release. Do not store operational logs in the checkout or append them to the project authority ledger. Native database error summaries are not a general-purpose redaction engine, so application input validation and scoped database access remain necessary.

References: [Compose project naming](https://docs.docker.com/compose/how-tos/environment-variables/envvars/), [Docker logging recommendations](https://docs.docker.com/engine/logging/configure/), [local driver options](https://docs.docker.com/engine/logging/drivers/local/), and [PostgreSQL logging settings](https://www.postgresql.org/docs/15/runtime-config-logging.html).

### Configuration and first use

Configuration ownership:

| Configuration                                   | Location                                                         | Consumer                                      |
| ----------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| Model endpoint, model name, queue/daily budgets | `.local/runtime.env`                                             | API process                                   |
| Model provider key                              | `.local/secrets/model-key`                                       | API private runtime file                      |
| PostgreSQL connection                           | `.local/secrets/database-url`                                    | API private runtime file                      |
| Navis human/agent device credentials            | `.local/credentials/human.json`, `.local/credentials/agent.json` | Headless operator or Bridge                   |
| Bridge connection and Outbox                    | The Bridge data directory                                        | Per-user daemon                               |
| Project binding                                 | The consuming project's `navis.toml`                             | Bridge; server verification remains mandatory |

The container receives a separate PostgreSQL password file at `.local/secrets/postgres-password`; setup creates it together with the connection file. A minimal bootstrap copies the mounted secrets to private volatile storage and drops privileges before starting the API. PostgreSQL consumes its own password secret.

The model provider key is not a Navis login credential. A project declaration contains only its project ID and optional Navis instance URL. It must not contain either kind of key. Model calls occur only for an authorized assistance request; configuring a key does not authorize autonomous acceptance or external execution.

For a fresh local configuration, first put the provider key in a private file, then run:

```bash
pnpm instance setup --model-base-url https://provider.example/v1 --model model-name --model-key-file /path/to/private/provider-key
pnpm instance up
pnpm instance provision --kind human --name 'Local operator'
pnpm instance provision --kind agent --name 'Project agent'
pnpm build
pnpm instance install-client
```

Setup preserves existing configuration. Provisioning preserves an existing credential file rather than silently issuing another device. The command prints the file path and public IDs; it does not print the secret. Keep the human credential for accountable human actions and give the Bridge the agent credential:

```bash
.local/bin/navis configure --remote http://127.0.0.1:8080 --credential-file .local/credentials/agent.json
.local/bin/navis status
```

Use a separate Bridge profile for human operations. Configure both profiles from the Navis checkout; the installed wrapper respects `NAVIS_HOME`:

```bash
NAVIS_HOME="$HOME/.navis/human" .local/bin/navis configure --remote http://127.0.0.1:8080 --credential-file .local/credentials/human.json
```

From the consuming project directory, the human creates the project and grants the agent membership. Replace the executable path and public participant ID with the provisioned values:

```bash
NAVIS_BIN=/path/to/Navis/.local/bin/navis
NAVIS_HOME="$HOME/.navis/human" "$NAVIS_BIN" init --name 'My project'
NAVIS_HOME="$HOME/.navis/human" "$NAVIS_BIN" member --participant <agent-participant-id> --action grant
"$NAVIS_BIN" projects
"$NAVIS_BIN" state
"$NAVIS_BIN" hook
```

`init` creates authority, writes a new `navis.toml` and verifies the binding. It refuses to overwrite an existing declaration. An agent may also create a project and grant the human membership; it still needs the human to create Work and accept results. Use the human profile only for the operator's explicit decisions. A project listing or declaration alone does not grant membership.

Human-only commands still require a human credential. Changing a name in a credential file does not change server identity; the Bridge verifies credential metadata and detects file changes. Reconfigure after an intentional credential update. Pending captures must be drained before changing the connection identity or remote.

## Agent skill and cross-project use

CLI and Bridge are the runtime integration. The optional [Navis skill](../integrations/skills/navis/SKILL.md) teaches an external coding Agent to read context, use Equip/Return and synchronize selected observations through that client. It introduces no new service or authorization path. Installing a skill does not register automatic hooks or an MCP server.

After `pnpm build` and `pnpm instance install-client`, install it in the desired tool's user skill directory. For example, on macOS/Linux:

```bash
pnpm instance install-skill --skill-dir "$HOME/.codex/skills/navis"
pnpm instance install-skill --skill-dir "$HOME/.claude/skills/navis"
```

On Windows PowerShell:

```powershell
pnpm instance install-skill --skill-dir (Join-Path $HOME '.codex/skills/navis')
pnpm instance install-skill --skill-dir (Join-Path $HOME '.claude/skills/navis')
```

Choose only the tools you use; a custom skill root can be supplied explicitly. The installed copy records the pinned Node executable and client entry. Machine paths stay outside the source repository. Reinstall the skill after moving the checkout or runtime. Open a new Agent session to discover the newly installed skill, then ask it to use Navis in the consuming project. A client need not be on PATH when the installed skill supplies its command.

For direct terminal use, add the installation's `.local/bin` directory to your user PATH. Keep the launchers together with their installed client; copying a launcher to another directory does not install the package. On Windows, use the generated `navis.cmd` entry. From a bound project directory, `navis status`, `navis hook` and `navis state` check the connection and current project.

The operator configures separate human/agent credentials and the intended project membership as above. The Agent can then check `status`, `hook` and `state`, obtain Equip for existing Work, submit a Return and synchronize explicit capture. Missing Work or human approval remains a human action. Loading this skill does not automatically record every conversation; automatic tool-specific hook adapters are separate integration work.

## Commands, capture and model jobs

`navis command --file command.json --request-id <stable-key>` sends a schema-validated project command. Reuse the key only for an identical retry. The supported command vocabulary is defined by `projectCommandSchema`; actor identity and timestamps come from the serving boundary. Read the current `state_version` from `navis state` for `expected_version`. For a new project, a human creates work by saving this JSON as `work.json`:

```json
{
  "type": "work.create",
  "title": "First experiment",
  "reason": "Verify the project workflow",
  "expected_version": 0
}
```

```bash
NAVIS_HOME="$HOME/.navis/human" "$NAVIS_BIN" command --file work.json --request-id <stable-key>
```

The response contains `result.value.id`. The next agent command is `{"type":"equip.issue","work_id":"<work-id>","expected_version":0}`. Return text with `{"type":"return.submit","equip_id":"<equip-id>","expected_version":0,"candidates":[{"kind":"artifact","content":{"storage":"inline","media_type":"text/plain","text":"Reviewable result"}}]}`. If a SHA-256 is supplied, it must match the UTF-8 text. `navis state` exposes candidate IDs and reviewable content.

A human reviews a candidate and sends `{"type":"asset.accept","asset_id":"<asset-id>","result":"accepted","criteria_snapshot":{"review":"Describe the checked criteria"},"expected_version":0}`. The human then records delivery with `delivery.record` (`asset_id`, `target_ref`, `target_type`, `expected_version`) and confirms its observed outcome with `delivery.confirm` (`delivery_id`, `outcome: "confirmed"`, `expected_version`). All examples use the initial business version; use the actual version after boundary/status changes. Unknown or executing effects block delivery until a terminal execution fact is recorded.

An agent can issue its Equip, return candidates and record execution facts under its grants. Acceptance, governed lifecycle changes and delivery confirmation retain the Domain gates. Recording an effect does not execute a shell command or an external API action.

Capture a session step with a stable UUIDv7 request ID when retries are possible:

```bash
/path/to/Navis/.local/bin/navis capture --file step.json --session experiment-1 --request-id <uuidv7>
/path/to/Navis/.local/bin/navis sync
/path/to/Navis/.local/bin/navis history --types session --limit 20
```

```json
{ "kind": "user.message", "body": "The local source text to observe" }
```

Metadata capture transmits structural metadata and a hash. `--local-only` reduces the local upload scope. A human can govern the project ceiling with `project.policy` and `capture_privacy`; the supported automatic capture levels are `metadata` and `local-only`. An offline client uses its verified cache and marks stale context; the upload path checks current server policy before sending. Rejected and unconfirmed data is retained. Authentication failures or exhausted retry budgets pause automatic transfer; `status` exposes the condition and `sync` explicitly resumes an attempt.

To request model assistance:

```json
{ "prompt": "Propose a short experiment plan for human review.", "expected_version": 0 }
```

```bash
/path/to/Navis/.local/bin/navis assist --file assistance.json --request-id <stable-key>
/path/to/Navis/.local/bin/navis assist-status --job <job-id>
```

The API stores a durable job, generates candidate text, records the configured model identity, and submits an idempotent candidate command. The returned candidate requires human review. Project `local-only` policy refuses external model assistance. The default profile permits one active generation, at most three attempts, 32 pending/running jobs and 100 accepted jobs per rolling 24 hours. Set `NAVIS_MODEL_PENDING_LIMIT` and `NAVIS_MODEL_DAILY_LIMIT` deliberately when changing those budgets.

Ledger reads and writes share a configured per-project byte budget (8 MiB by default). Capacity rejection preserves the last readable state. Change `NAVIS_LEDGER_BYTES` in `.local/runtime.env` together with an appropriate `NAVIS_API_MEMORY` allocation, then recreate the API. HTTP requests are bounded and concurrent intake is limited; increasing a limit is an operational change, not a way to bypass authorization.

## Operations and recovery

```bash
pnpm instance status
pnpm instance restart
pnpm instance backup
pnpm instance restore-check .local/backups/<backup>.dump.enc
```

Backups are authenticated AES-256-GCM archives. Preserve `.local/secrets/backup-key` separately with operator-controlled access; losing it makes encrypted backups unreadable. `restore-check` authenticates the archive first and restores into a temporary, network-isolated PostgreSQL container. It never overwrites the running database. For a full authority check, save the human profile's `navis state` response immediately before a backup while the project is idle, then run:

```bash
pnpm instance restore-check .local/backups/<backup>.dump.enc --credential-file .local/credentials/human.json --snapshot-file /path/to/private/snapshot.json
```

This starts a temporary API container using the same service image and the isolated database network namespace, authenticates the original device credential and compares the entire restored projection, grants and ledger cursor. Keep the snapshot private. A snapshot taken after a later write is expected to differ from an older backup. Production data remains in the named Compose volume; do not remove that volume as a restart procedure.

A stalled database makes `/readyz` return 503 within its deadline while `/healthz` reports API process liveness. If the database process exits, its container restart policy recovers it while the API reports dependency failure. Recreating the API preserves committed projects and jobs in the separate database volume. A crashed Bridge recovers captured/sending records from SQLite and reuses event identities. A lost server reply cannot produce a second ledger event on retry.

The supplied model transport is compatible with the provider's chat-completions endpoint. Its key stays in the API secret mount, never in CLI arguments, model prompts, project declarations or logs. Provider authentication failures and malformed responses become safe job errors. The profile does not expose arbitrary model tool execution.

## Deployment scope and operator responsibilities

This profile is for one operator-controlled machine and is best-effort. It has no public-service availability promise. Keep the HTTP listener on loopback; another local project connects to the same API, not to PostgreSQL. A different physical machine needs a separately reviewed TLS deployment and its own Navis device credential. Model configuration belongs to the API instance hosting that project, not to each consuming repository.

The operator owns backup frequency, available disk space and credential custody. Run a backup after valuable experiments, store the encrypted archive and backup key separately, and periodically repeat the restore drill. Backup RPO is the last successful backup; no tighter recovery guarantee is claimed. Inspect `docker compose --env-file .local/runtime.env logs --tail 100 api` and `navis status` for failed jobs, paused uploads and capacity failures. `stop` stops that profile's daemon; the next CLI invocation restarts it. Do not delete Outbox data to clear an error.

The SQL schema is an unreleased baseline. Existing installations with a changed baseline fail checksum verification; preserve a verified backup and use a fresh database rather than rewriting checksum history. `restart` reuses the installed API image; after a source update, validate, rebuild with `pnpm instance up`, and reinstall the client from a successful `pnpm build`. Stop existing Bridge profiles before replacing their installed package.

The current profile provides explicit CLI/hook capture, candidate-only model jobs and human command review. Automatic integrations with every external coding tool, raw/encrypted transcript transfer, unrestricted model tools, per-job cancellation, multi-host availability, dashboards and public release automation are not implemented. These need separate requirements and evidence; a passing local gate does not establish those capabilities.

## Resource identifiers and database support

Project, Work, Equip, asset, device and job IDs identify the exact resource an operation reads or changes. They are generated by Navis and returned in command responses; they are not model keys. `init` generates the project ID and writes its binding. Most CLI commands infer the project from `navis.toml`, and ordinary invocations generate a request ID automatically. Supply a stable `--request-id` only when deliberately retrying the same operation. Membership uses the participant ID returned by provisioning; model job status uses the job ID returned by `assist`.

The shipped server database is PostgreSQL 15+. Its SQL baseline uses PostgreSQL-specific data types, locks and triggers. SQLite is used only for the local Bridge. Other SQL engines require dedicated adapters and contract tests. An application using MySQL, SQLite, files or another database can still use Navis through its API; it does not connect directly to Navis's database.

Normal operation uses one Compose project with an API container and a PostgreSQL container. They have separate lifecycle and resource budgets. `pnpm instance status` shows both; backup restoration uses disposable verification resources and removes them when the command finishes. Instance-specific inventories, generated IDs and verification logs do not belong in repository documentation.

## Windows PowerShell workflow

Setup, startup, provisioning, backup and installation use the same `pnpm instance` commands as other hosts. After building and installing, configure separate agent and human profiles from the checkout:

```powershell
$Navis = (Resolve-Path .\.local\bin\navis.cmd).Path
& $Navis configure --remote http://127.0.0.1:8080 --credential-file .\.local\credentials\agent.json
$AgentId = (Get-Content .\.local\credentials\agent.json -Raw | ConvertFrom-Json).participant_id
$env:NAVIS_HOME = Join-Path $HOME '.navis\human'
& $Navis configure --remote http://127.0.0.1:8080 --credential-file .\.local\credentials\human.json
```

In the consuming project's directory, create the project and grant that agent membership, then return to the default agent profile:

```powershell
& $Navis init --name 'My project'
& $Navis member --participant $AgentId --action grant
Remove-Item Env:NAVIS_HOME
& $Navis state
& $Navis hook
```

Keep the human profile selected only for explicit human decisions. Files and command JSON use the same public contracts on all three operating systems. Write command JSON as UTF-8; a UTF-8 BOM is accepted. For Windows PowerShell 5.1, use `Set-Content -Encoding UTF8` rather than its default UTF-16 redirection.

## Additional users and machines

An operator provisions separate credentials for each identity/device instead of sharing the default human or agent file:

```bash
pnpm instance provision --kind agent --name 'Additional project agent' --credential-name additional-agent
```

The resulting file is in the private credentials directory. An existing name is preserved to avoid silently replacing a device's credential. Transfer credentials through an operator-controlled secure channel, store them under the recipient's own private account, and grant only the intended project memberships. Never distribute the model provider key to consuming projects.

`127.0.0.1` means the current machine. Users can deploy their own instance without depending on another developer's computer. Connecting another physical machine to a shared instance requires an operator-managed HTTPS endpoint or secure tunnel and that client's own device credential. The default Compose listener remains on loopback; installation does not publish the host to a LAN or the Internet.
