import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  bridgeHookResultSchema,
  deviceListResponseSchema,
  projectSnapshotSchema,
  type ContextSummary,
} from '@navis/contracts';
import { uuidv7, hashCommandPayload } from '@navis/domain';
import { NodeBridgeDaemon } from '../daemon.js';
import { NodeIpcServer } from '../ipc.js';
import { resolveDaemonPaths, type DaemonPaths } from '../paths.js';
import { openDaemonDb, SqliteBindingTable } from '../persistence/sqlite-binding.js';
import { SqliteOutbox } from '../outbox/sqlite-outbox.js';
import { tick } from '../outbox/upload-loop.js';
import { NavisClient, readCredential, RemoteError } from '../remote/client.js';
import { IngestSender } from '../remote/ingest-sender.js';
import { bindFromToml } from '../binding/bind-service.js';
import { findTomlUp, parseTomlBytes } from '../binding/toml.js';
import { extractSessionEvents } from '../session/extract.js';
import { bridgeRequestSchema, type BridgeRequest } from './request.js';

const connectionSchema = z.strictObject({
  remote: z.string(),
  credential_file: z.string(),
  fingerprint: z.string(),
});

/** Owns the live client resources; operation modules own parsing, binding and transfer rules. */
export class BridgeRuntime {
  readonly #db: DatabaseSync;
  readonly #outbox: SqliteOutbox;
  readonly #bindings: SqliteBindingTable;
  readonly #daemon: NodeBridgeDaemon;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closing = false;
  #closed: Promise<void> | undefined;
  #syncing: Promise<unknown> | undefined;

  constructor(readonly paths: DaemonPaths = resolveDaemonPaths()) {
    this.#db = openDaemonDb(path.join(paths.dataDir, 'bridge.sqlite'));
    this.#outbox = new SqliteOutbox(this.#db);
    this.#bindings = new SqliteBindingTable(this.#db);
    this.#daemon = new NodeBridgeDaemon({
      paths,
      ipcFactory: () =>
        new NodeIpcServer(async (input) => {
          try {
            return { ok: true, data: await this.handle(bridgeRequestSchema.parse(input)) };
          } catch (error) {
            return {
              ok: false,
              detail:
                error instanceof RemoteError
                  ? error.message
                  : 'Bridge operation failed; check configuration and command input.',
            };
          }
        }),
    });
  }

  #setting(key: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM runtime_settings WHERE key=?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }
  #set(key: string, value: string): void {
    this.#db
      .prepare(
        'INSERT INTO runtime_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  #connection() {
    return connectionSchema.parse(JSON.parse(this.#setting('connection') ?? 'null'));
  }
  #client(): NavisClient {
    const c = this.#connection();
    return new NavisClient(c.remote, c.credential_file, c.fingerprint);
  }

  async start(): Promise<{ pid: number; created: boolean }> {
    const running = await this.#daemon.ensureRunning();
    if (!running.created) {
      this.#closing = true;
      this.#closed = Promise.resolve();
      this.#db.close();
      return running;
    }
    const interrupted = this.#db
      .prepare("SELECT event_id FROM outbox_events WHERE state='sending'")
      .all() as { event_id: string }[];
    await this.#outbox.releaseSending(interrupted.map((row) => row.event_id));
    const captured = this.#db
      .prepare("SELECT event_id FROM outbox_events WHERE state='captured'")
      .all() as { event_id: string }[];
    for (const row of captured) await this.#outbox.promoteToPending(row.event_id, 'recovery');
    this.#schedule();
    return running;
  }

  #schedule(): void {
    if (this.#closing) return;
    this.#timer = setTimeout(() => {
      void this.sync()
        .catch(() => {
          if (!this.#closing) {
            this.#set('last_error', 'BRIDGE_SYNC_FAILED');
            this.#set('paused', 'true');
          }
        })
        .finally(() => {
          this.#schedule();
        });
    }, 2000);
  }

  sync(): Promise<unknown> {
    this.#syncing ??= this.#sync().finally(() => {
      this.#syncing = undefined;
    });
    return this.#syncing;
  }
  async #sync(): Promise<unknown> {
    if (this.#setting('connection') === undefined || this.#setting('paused') === 'true')
      return { paused: true };
    const connection = this.#connection();
    const credential = await readCredential(connection.credential_file);
    const slice = await tick(
      this.#outbox,
      new IngestSender(this.#client()),
      credential.device_id,
      new Date().toISOString(),
    );
    if (slice.error !== undefined)
      this.#set(
        'last_error',
        slice.error.startsWith('http_') ? slice.error : 'BRIDGE_TRANSFER_FAILED',
      );
    const exhausted = this.#db
      .prepare('SELECT 1 FROM outbox_events WHERE retry_count >= 8 LIMIT 1')
      .get();
    if (slice.error === 'http_401' || slice.error === 'http_403' || exhausted !== undefined)
      this.#set('paused', 'true');
    return {
      acked: slice.ackedCount,
      pending: this.#counts(),
      paused: this.#setting('paused') === 'true',
    };
  }
  #counts(): unknown {
    return this.#db
      .prepare('SELECT state,count(*) AS count FROM outbox_events GROUP BY state')
      .all();
  }

  async #bind(cwd: string, allowOffline = false) {
    const connection = this.#connection();
    const credential = await readCredential(connection.credential_file);
    const hit = findTomlUp(cwd);
    if (hit === null) throw new Error('navis.toml not found');
    const declaration = parseTomlBytes(hit.bytes);
    if (!declaration.ok) throw new Error('invalid navis.toml');
    if (
      declaration.declaration.remote !== null &&
      declaration.declaration.remote.replace(/\/$/, '') !== connection.remote
    )
      throw new Error('configure credentials for the declared remote first');
    const outcome = await bindFromToml(
      {
        bindings: this.#bindings,
        verifier: {
          verify: async (claim) => {
            let privacyClass: 'metadata' | 'local-only';
            try {
              const snapshot = projectSnapshotSchema.parse(
                await this.#client().request('GET', `/api/projects/${claim.projectId}/snapshot`),
              );
              privacyClass = snapshot.privacy_class;
            } catch (error) {
              if (!allowOffline || error instanceof RemoteError) throw error;
              const cached = await this.#bindings.get(hit.tomlPath, credential.device_id);
              if (cached?.project_id !== claim.projectId) throw error;
              privacyClass = cached.privacy_class === 'local-only' ? 'local-only' : 'metadata';
            }
            return { ok: true, participantId: credential.participant_id, privacyClass };
          },
        },
        keychain: { get: () => Promise.resolve(`${credential.key_id}.${credential.key_secret}`) },
        keychainRef: this.paths,
        now: () => new Date().toISOString(),
      },
      cwd,
      credential.device_id,
    );
    if (outcome.status !== 'bound') throw new Error(`binding refused: ${outcome.status}`);
    return outcome.binding;
  }

  async handle(request: BridgeRequest): Promise<unknown> {
    if (this.#closing) throw new Error('Bridge is shutting down');
    switch (request.op) {
      case 'ping':
        return { pid: process.pid, protocol: 1 };
      case 'status':
        return {
          pid: process.pid,
          protocol: 1,
          configured: this.#setting('connection') !== undefined,
          paused: this.#setting('paused') === 'true',
          outbox: this.#counts(),
          last_error: this.#setting('last_error') ?? null,
        };
      case 'configure': {
        const credential = await readCredential(request.credential_file);
        if (this.#setting('connection') !== undefined) {
          const previous = this.#connection();
          const pending = this.#db
            .prepare(
              "SELECT 1 FROM outbox_events WHERE state NOT IN ('local_only','quarantined') LIMIT 1",
            )
            .get();
          if (
            pending !== undefined &&
            (previous.remote !== request.remote ||
              previous.fingerprint !== hashCommandPayload(credential))
          )
            throw new Error('drain pending events before changing connection');
        }
        const identity = deviceListResponseSchema.parse(
          await new NavisClient(request.remote, request.credential_file).request(
            'GET',
            '/api/devices',
          ),
        );
        if (
          identity.device_id !== credential.device_id ||
          identity.participant_id !== credential.participant_id
        )
          throw new Error('credential metadata does not match the server identity');
        this.#set(
          'connection',
          JSON.stringify({
            remote: request.remote,
            credential_file: request.credential_file,
            fingerprint: hashCommandPayload(credential),
          }),
        );
        this.#set('paused', 'false');
        return { remote: request.remote, device_id: credential.device_id };
      }
      case 'project.create': {
        const target = request.cwd === undefined ? undefined : path.join(request.cwd, 'navis.toml');
        if (target !== undefined && existsSync(target))
          throw new Error('navis.toml already exists');
        const result = await this.#client().request(
          'POST',
          '/api/projects',
          request.request,
          request.key,
        );
        if (target !== undefined && request.cwd !== undefined) {
          writeFileSync(
            target,
            `project_id = "${request.request.project_id}"\nremote = "${this.#connection().remote}"\n`,
            { flag: 'wx', mode: 0o644 },
          );
          await this.#bind(request.cwd);
        }
        return result;
      }
      case 'project.state':
        return projectSnapshotSchema.parse(
          await this.#client().request('GET', `/api/projects/${request.project_id}/snapshot`),
        );
      case 'project.command':
        return this.#client().request(
          'POST',
          `/api/projects/${request.project_id}/commands`,
          { command: request.command },
          request.key,
        );
      case 'project.member':
        return this.#client().request(
          'POST',
          `/api/projects/${request.project_id}/members`,
          request.request,
          request.key,
        );
      case 'bind':
        return this.#bind(request.cwd);
      case 'capture': {
        const binding = await this.#bind(request.cwd, true);
        const privacy =
          request.privacy === 'local-only' || binding.privacy_class === 'local-only'
            ? 'local-only'
            : 'metadata';
        const inputs = extractSessionEvents([request.step], {
          deviceId: binding.device_id,
          projectId: binding.project_id,
          privacyClass: privacy,
          sourceSessionId: request.session_id,
          newEventId: () => request.event_id,
        });
        const captured = [];
        for (const input of inputs) {
          const receipt = await this.#outbox.captureOnce(
            input,
            hashCommandPayload({
              project: binding.project_id,
              device: binding.device_id,
              session: request.session_id,
              privacy: request.privacy,
              step: request.step,
            }),
            `${binding.device_id}:${binding.project_id}:${request.session_id}:${request.privacy}`,
          );
          if (!receipt.duplicate && privacy !== 'local-only')
            await this.#outbox.promoteToPending(input.event_id, binding.binding_id);
          captured.push(input.event_id);
        }
        return { captured };
      }
      case 'sync':
        this.#set('paused', 'false');
        return this.sync();
      case 'hook.session.start':
        return this.#hook(request.cwd, request.request_id);
      case 'project.context': {
        const query = new URLSearchParams({ limit: String(request.request.limit) });
        for (const type of request.request.filter.types) query.append('types', type);
        if (request.request.cursor !== undefined) query.set('cursor', request.request.cursor);
        if (request.request.filter.from !== undefined)
          query.set('from', request.request.filter.from);
        if (request.request.filter.to !== undefined) query.set('to', request.request.filter.to);
        return this.#client().request(
          'GET',
          `/api/projects/${request.request.project_id}/context?${query.toString()}`,
        );
      }
      case 'project.search': {
        const query = new URLSearchParams({
          query: request.request.query,
          limit: String(request.request.limit),
        });
        if (request.request.cursor !== undefined) query.set('cursor', request.request.cursor);
        return this.#client().request('GET', `/api/projects?${query.toString()}`);
      }
      case 'assistance.request':
        return this.#client().request(
          'POST',
          `/api/projects/${request.project_id}/assistance`,
          request.request,
          request.key,
        );
      case 'assistance.status':
        return this.#client().request(
          'GET',
          `/api/projects/${request.project_id}/assistance/${request.job_id}`,
        );
      case 'stop':
        setTimeout(() => {
          void this.close().catch(() => {
            process.stderr.write('Bridge shutdown failed.\n');
            process.exitCode = 1;
          });
        }, 25);
        return { stopping: true };
    }
  }

  async #hook(cwd: string, requestId: string): Promise<unknown> {
    const previous = this.#setting(`hook:${requestId}`);
    if (previous !== undefined) {
      const record = JSON.parse(previous) as { cwd: string; event_id: string };
      if (record.cwd !== cwd) throw new Error('hook identity reused for another directory');
      return bridgeHookResultSchema.parse({ status: 'reused', event_id: record.event_id });
    }
    if (findTomlUp(cwd) === null)
      return bridgeHookResultSchema.parse({ status: 'unbound', reason: 'no-navis-toml' });
    try {
      const binding = await this.#bind(cwd, true);
      const cacheKey = `context:${binding.project_id}`;
      const cached = this.#setting(cacheKey);
      let snapshot;
      let marker: 'advanced' | 'unchanged' | 'stale';
      let cachedAt = this.#setting(`${cacheKey}:at`);
      try {
        snapshot = projectSnapshotSchema.parse(
          await this.#client().request('GET', `/api/projects/${binding.project_id}/snapshot`),
        );
        const old = cached === undefined ? null : projectSnapshotSchema.parse(JSON.parse(cached));
        marker = old?.ledger_seq === snapshot.ledger_seq ? 'unchanged' : 'advanced';
        cachedAt = new Date().toISOString();
        this.#set(cacheKey, JSON.stringify(snapshot));
        this.#set(`${cacheKey}:at`, cachedAt);
      } catch (error) {
        if (error instanceof RemoteError || cached === undefined || cachedAt === undefined)
          throw error;
        snapshot = projectSnapshotSchema.parse(JSON.parse(cached));
        marker = 'stale';
      }
      const project = snapshot.projection.project;
      if (project === null) throw new Error('project state unavailable');
      const summary: ContextSummary = {
        project_name: project.title,
        project_status: project.status,
        state_version: snapshot.state_version,
        active_work_count: Object.values(snapshot.projection.works).filter(
          (work) => work['status'] !== 'cancelled' && work['status'] !== 'completed',
        ).length,
        open_hold_count: Object.values(snapshot.projection.holds).filter(
          (hold) => hold['status'] === 'active',
        ).length,
        last_update_at: project.updated_at ?? project.created_at,
      };
      const eventId = uuidv7();
      const result = bridgeHookResultSchema.parse({
        status: 'bound',
        bound_source: 'toml',
        event_id: eventId,
        project_id: binding.project_id,
        change_marker: marker,
        ledger_seq: snapshot.ledger_seq,
        ...(marker === 'stale' ? { cached_at: cachedAt } : {}),
        context_summary: summary,
      });
      this.#set(`hook:${requestId}`, JSON.stringify({ cwd, event_id: eventId }));
      return result;
    } catch (error) {
      return bridgeHookResultSchema.parse({
        status: 'unbound',
        reason:
          error instanceof RemoteError && (error.status === 401 || error.status === 403)
            ? 'member-denied'
            : 'project-unverified',
      });
    }
  }

  close(): Promise<void> {
    if (this.#closed !== undefined) return this.#closed;
    this.#closing = true;
    clearTimeout(this.#timer);
    this.#closed = Promise.allSettled([this.#daemon.stop(), this.#syncing]).then(([listener]) => {
      this.#db.close();
      // A failed transfer remains durable for recovery; a failed listener shutdown is terminal.
      if (listener.status === 'rejected') throw listener.reason;
    });
    return this.#closed;
  }
}
