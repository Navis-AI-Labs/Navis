import { NavisClient, RemoteError } from '../src/remote/client.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiRuntime, loadApiConfig, type ApiRuntime } from '@navis/api';
import { createHash } from 'node:crypto';
import { uuidv7 } from '@navis/domain';
import {
  projectSnapshotSchema,
  bridgeHookResultSchema,
  type DeviceCredential,
} from '@navis/contracts';
import { BridgeRuntime } from '../src/runtime/runtime.js';
import { sendBridge } from '../src/runtime/client.js';
import { resolveDaemonPaths } from '../src/paths.js';

const configured = process.env['DATABASE_URL']?.trim();
const databaseUrl = configured === '' ? undefined : configured;
describe.runIf(databaseUrl !== undefined)(
  'Bridge with real IPC, SQLite, HTTP and PostgreSQL',
  () => {
    let api: ApiRuntime;
    let bridge: BridgeRuntime;
    let remote: string;
    let dir: string;
    let credential: DeviceCredential;
    let credentialFile: string;
    let socket: string;
    let projectId: string;
    beforeAll(async () => {
      dir = mkdtempSync('/tmp/nv-');
      api = await createApiRuntime(
        { ...loadApiConfig({ DATABASE_URL: databaseUrl }), port: 0 },
        { write: () => undefined },
      );
      if (api.provision === undefined) throw new Error('provisioning required');
      credential = await api.provision('Bridge integration owner', 'human');
      remote = `http://127.0.0.1:${String(await api.listen())}`;
      credentialFile = path.join(dir, 'device.json');
      writeFileSync(credentialFile, JSON.stringify(credential), { mode: 0o600 });
      const paths = resolveDaemonPaths({
        env: { NAVIS_HOME: path.join(dir, 'data') },
        platform: 'darwin',
      });
      socket = paths.socketPath;
      bridge = new BridgeRuntime(paths);
      expect((await bridge.start()).created).toBe(true);
      await sendBridge({ op: 'configure', remote, credential_file: credentialFile }, socket);
      projectId = uuidv7();
      await sendBridge(
        {
          op: 'project.create',
          key: uuidv7(),
          cwd: dir,
          request: { project_id: projectId, title: 'Bridge integration' },
        },
        socket,
      );
    });
    afterAll(async () => {
      await bridge.close();
      await api.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });
    it('reuses the IPC holder and exposes configured state', async () => {
      expect(await sendBridge({ op: 'status' }, socket)).toMatchObject({
        configured: true,
        protocol: 1,
      });
      const second = new BridgeRuntime(bridge.paths);
      expect((await second.start()).created).toBe(false);
      await second.close();
      await expect(second.handle({ op: 'status' })).rejects.toThrow('shutting down');
    });
    it('refreshes a hook when ledger progress changes without business version changes', async () => {
      const first = bridgeHookResultSchema.parse(
        await sendBridge({ op: 'hook.session.start', cwd: dir, request_id: uuidv7() }, socket),
      );
      expect(first.status).toBe('bound');
      const command = {
        type: 'work.create' as const,
        title: 'new activity',
        reason: 'refresh probe',
        expected_version: 0,
      };
      await sendBridge(
        { op: 'project.command', project_id: projectId, command, key: uuidv7() },
        socket,
      );
      const requestId = uuidv7();
      const second = bridgeHookResultSchema.parse(
        await sendBridge({ op: 'hook.session.start', cwd: dir, request_id: requestId }, socket),
      );
      expect(second).toMatchObject({
        status: 'bound',
        change_marker: 'advanced',
        context_summary: { state_version: 0, active_work_count: 1 },
      });
      expect(
        bridgeHookResultSchema.parse(
          await sendBridge({ op: 'hook.session.start', cwd: dir, request_id: requestId }, socket),
        ),
      ).toMatchObject({ status: 'reused' });
      expect(
        bridgeHookResultSchema.parse(
          await sendBridge({ op: 'hook.session.start', cwd: dir, request_id: uuidv7() }, socket),
        ),
      ).toMatchObject({ status: 'bound', change_marker: 'unchanged' });
    });
    it('uploads canonical metadata through the actual receipt format and keeps local-only captures local', async () => {
      const before = projectSnapshotSchema.parse(
        await sendBridge({ op: 'project.state', project_id: projectId }, socket),
      );
      const capture = (await sendBridge(
        {
          op: 'capture',
          event_id: uuidv7(),
          cwd: dir,
          step: { kind: 'user.message', body: 'private project source' },
          session_id: 'real-session',
          privacy: 'metadata',
        },
        socket,
      )) as { captured: string[] };
      expect(capture.captured).toHaveLength(1);
      expect(await sendBridge({ op: 'sync' }, socket)).toMatchObject({ acked: 1 });
      const after = projectSnapshotSchema.parse(
        await sendBridge({ op: 'project.state', project_id: projectId }, socket),
      );
      expect(after.ledger_seq).toBe(before.ledger_seq + 1);
      expect(after.state_version).toBe(before.state_version);
      await sendBridge(
        {
          op: 'capture',
          event_id: uuidv7(),
          cwd: dir,
          step: { kind: 'agent.message', body: 'local-only detail' },
          session_id: 'local-session',
          privacy: 'local-only',
        },
        socket,
      );
      await sendBridge({ op: 'sync' }, socket);
      expect(
        projectSnapshotSchema.parse(
          await sendBridge({ op: 'project.state', project_id: projectId }, socket),
        ).ledger_seq,
      ).toBe(after.ledger_seq);
    });
    it('returns an explicit unbound hook result for directories without a declaration', async () => {
      const unbound = path.join(dir, 'empty');
      mkdirSync(unbound);
      const standalone = mkdtempSync('/tmp/nu-');
      try {
        expect(
          await sendBridge(
            { op: 'hook.session.start', cwd: standalone, request_id: uuidv7() },
            socket,
          ),
        ).toMatchObject({ status: 'unbound', reason: 'no-navis-toml' });
      } finally {
        rmSync(standalone, { recursive: true, force: true });
      }
    });
    it('cannot retarget credentials to a different remote through a declaration', async () => {
      const location = path.join(dir, 'other');
      mkdirSync(location);
      writeFileSync(
        path.join(location, 'navis.toml'),
        `project_id = "${projectId}"\nremote = "https://other.invalid"\n`,
      );
      await expect(sendBridge({ op: 'bind', cwd: location }, socket)).rejects.toThrow(
        'Bridge operation failed',
      );
    });
    it('persists captures and settings across actual resource teardown', async () => {
      await bridge.close();
      bridge = new BridgeRuntime(bridge.paths);
      await bridge.start();
      expect(await sendBridge({ op: 'status' }, socket)).toMatchObject({
        configured: true,
        outbox: [{ state: 'local_only', count: 1 }],
      });
      const snapshot = projectSnapshotSchema.parse(
        await sendBridge({ op: 'project.state', project_id: projectId }, socket),
      );
      expect(snapshot.projection.project?.title).toBe('Bridge integration');
    });
    it('does not grant candidate material acceptance during capture or project proposal', async () => {
      const text = 'candidate';
      await sendBridge(
        {
          op: 'project.command',
          project_id: projectId,
          key: uuidv7(),
          command: {
            type: 'asset.propose',
            kind: 'knowledge',
            expected_version: 0,
            content: {
              storage: 'inline',
              media_type: 'text/plain',
              text,
              sha256: createHash('sha256').update(text).digest('hex'),
            },
          },
        },
        socket,
      );
      const snapshot = projectSnapshotSchema.parse(
        await sendBridge({ op: 'project.state', project_id: projectId }, socket),
      );
      expect(Object.values(snapshot.projection.assets).at(-1)?.['lifecycle']).toBe('candidate');
    });
    it('provides project listing and captured metadata through history', async () => {
      const projects = (await sendBridge(
        { op: 'project.search', request: { query: 'Bridge', limit: 20 } },
        socket,
      )) as { results: unknown[] };
      expect(projects.results.length).toBeGreaterThan(0);
      const history = (await sendBridge(
        {
          op: 'project.context',
          request: {
            project_id: projectId,
            filter: {
              types: ['session'],
              from: '2026-01-01T00:00:00.000Z',
              to: '2027-01-01T00:00:00.000Z',
            },
            limit: 1,
          },
        },
        socket,
      )) as { entries: { payload: unknown; metadata: unknown }[] };
      expect(history.entries[0]?.payload).toHaveProperty('privacy');
      expect(history.entries[0]?.metadata).toHaveProperty('source_runtime');
      await sendBridge(
        {
          op: 'project.context',
          request: {
            project_id: projectId,
            filter: { types: ['session'] },
            limit: 1,
            cursor: Buffer.from(JSON.stringify({ seq: 1 })).toString('base64url'),
          },
        },
        socket,
      );
    });
    it('enforces project capture policy and prevents a personal setting from raising it', async () => {
      await sendBridge(
        {
          op: 'project.command',
          project_id: projectId,
          key: uuidv7(),
          command: {
            type: 'project.policy',
            capture_privacy: 'local-only',
            reason: 'private project',
            expected_version: 0,
          },
        },
        socket,
      );
      const before = projectSnapshotSchema.parse(
        await sendBridge({ op: 'project.state', project_id: projectId }, socket),
      );
      expect(before.privacy_class).toBe('local-only');
      const eventId = uuidv7();
      await sendBridge(
        {
          op: 'capture',
          event_id: eventId,
          cwd: dir,
          step: { kind: 'agent.message', body: 'must stay local' },
          session_id: 'privacy',
          privacy: 'metadata',
        },
        socket,
      );
      await sendBridge({ op: 'sync' }, socket);
      expect(
        projectSnapshotSchema.parse(
          await sendBridge({ op: 'project.state', project_id: projectId }, socket),
        ).ledger_seq,
      ).toBe(before.ledger_seq);
      await sendBridge(
        {
          op: 'project.command',
          project_id: projectId,
          key: uuidv7(),
          command: {
            type: 'project.policy',
            capture_privacy: 'metadata',
            reason: 'restore policy',
            expected_version: 0,
          },
        },
        socket,
      );
    });
    it('rejects invalid declarations, duplicate initialization and mutated credential metadata', async () => {
      await expect(
        sendBridge(
          {
            op: 'project.create',
            key: uuidv7(),
            cwd: dir,
            request: { project_id: uuidv7(), title: 'duplicate' },
          },
          socket,
        ),
      ).rejects.toThrow();
      const invalid = path.join(dir, 'invalid');
      mkdirSync(invalid);
      writeFileSync(path.join(invalid, 'navis.toml'), 'invalid');
      await expect(sendBridge({ op: 'bind', cwd: invalid }, socket)).rejects.toThrow();
      const source = readFileSync(credentialFile, 'utf8');
      writeFileSync(credentialFile, JSON.stringify({ ...credential, participant_id: uuidv7() }));
      await expect(
        sendBridge({ op: 'configure', remote, credential_file: credentialFile }, socket),
      ).rejects.toThrow();
      await expect(
        sendBridge({ op: 'project.state', project_id: projectId }, socket),
      ).rejects.toThrow();
      writeFileSync(credentialFile, source);
      await sendBridge({ op: 'configure', remote, credential_file: credentialFile }, socket);
    });
    it('recovers interrupted captures and refuses connection switching with pending data', async () => {
      await bridge.close();
      const db = new DatabaseSync(path.join(bridge.paths.dataDir, 'bridge.sqlite'));
      const eventId = uuidv7();
      const at = new Date().toISOString();
      const event = {
        schema_version: 1,
        event_type: 'user.message',
        occurred_at: at,
        project_id: projectId,
        source_runtime: 'recovery-test',
        source_session_id: 'recovery',
        raw_ref: 'session://recovery',
        extractor_version: '1',
        confidence: 1,
        review_status: 'pending',
        payload: { privacy: { char_length: 0, sha256: 'a'.repeat(64) } },
      };
      db.prepare(
        "INSERT INTO outbox_events(event_id,device_id,project_id,state,event_type,captured_at,event_json) VALUES (?,?,?,'captured',?,?,?)",
      ).run(eventId, credential.device_id, projectId, 'user.message', at, JSON.stringify(event));
      db.prepare(
        "INSERT INTO outbox_events(event_id,device_id,project_id,state,event_type,captured_at,event_json,seq) VALUES (?,?,?,'sending',?,?,?,10000)",
      ).run(uuidv7(), credential.device_id, projectId, 'user.message', at, JSON.stringify(event));
      db.close();
      bridge = new BridgeRuntime(bridge.paths);
      await bridge.start();
      await expect(
        sendBridge(
          { op: 'configure', remote: 'http://127.0.0.1:1', credential_file: credentialFile },
          socket,
        ),
      ).rejects.toThrow();
      expect(await sendBridge({ op: 'sync' }, socket)).toMatchObject({ acked: 1 });
    });
    it('keeps offline captures and reports stale context until the same service recovers', async () => {
      await sendBridge({ op: 'hook.session.start', cwd: dir, request_id: uuidv7() }, socket);
      await api.close();
      const stale = await sendBridge(
        { op: 'hook.session.start', cwd: dir, request_id: uuidv7() },
        socket,
      );
      expect(stale).toMatchObject({ status: 'bound', change_marker: 'stale' });
      await sendBridge(
        {
          op: 'capture',
          event_id: uuidv7(),
          cwd: dir,
          step: { kind: 'user.message', body: 'offline capture' },
          session_id: 'offline',
          privacy: 'metadata',
        },
        socket,
      );
      await sendBridge({ op: 'sync' }, socket);
      const status = (await sendBridge({ op: 'status' }, socket)) as {
        outbox: { state: string; count: number }[];
      };
      expect(status.outbox.some((row) => row.state === 'pending')).toBe(true);
      api = await createApiRuntime(
        { ...loadApiConfig({ DATABASE_URL: databaseUrl }), port: Number(new URL(remote).port) },
        { write: () => undefined },
      );
      await api.listen();
      await new Promise((resolve) => setTimeout(resolve, 2100));
      await sendBridge({ op: 'sync' }, socket);
    });
    it('handles refusals, missing caches and administrative requests without losing queued data', async () => {
      await expect(
        bridge.handle({
          op: 'project.member',
          project_id: projectId,
          key: uuidv7(),
          request: { participant_id: credential.participant_id, action: 'revoke' },
        }),
      ).rejects.toThrow();
      await expect(
        bridge.handle({
          op: 'assistance.request',
          project_id: projectId,
          key: uuidv7(),
          request: { prompt: 'not enabled on this fixture', expected_version: 0 },
        }),
      ).rejects.toThrow();
      await expect(
        bridge.handle({ op: 'assistance.status', project_id: projectId, job_id: uuidv7() }),
      ).rejects.toThrow();
      await bridge.handle({
        op: 'project.search',
        request: {
          query: 'Bridge',
          limit: 1,
          cursor: Buffer.from(JSON.stringify({ title: '', id: uuidv7() })).toString('base64url'),
        },
      });
      const fresh = mkdtempSync('/tmp/nf-');
      try {
        await expect(bridge.handle({ op: 'bind', cwd: fresh })).rejects.toThrow('not found');
        writeFileSync(path.join(fresh, 'navis.toml'), `project_id = "${projectId}"\n`);
        const spy = vi
          .spyOn(NavisClient.prototype, 'request')
          .mockRejectedValueOnce(new Error('offline'));
        await expect(
          bridge.handle({
            op: 'capture',
            event_id: uuidv7(),
            cwd: fresh,
            step: { kind: 'user.message', body: 'not bound' },
            session_id: 's',
            privacy: 'metadata',
          }),
        ).rejects.toThrow();
        spy.mockRestore();
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
      const requestId = uuidv7();
      await bridge.handle({ op: 'hook.session.start', cwd: dir, request_id: requestId });
      await expect(
        bridge.handle({ op: 'hook.session.start', cwd: '/', request_id: requestId }),
      ).rejects.toThrow('another directory');
      const spy = vi
        .spyOn(NavisClient.prototype, 'request')
        .mockRejectedValueOnce(new RemoteError(403, 'FORBIDDEN'));
      expect(
        await bridge.handle({ op: 'hook.session.start', cwd: dir, request_id: uuidv7() }),
      ).toMatchObject({ status: 'unbound', reason: 'member-denied' });
      spy.mockRestore();
      const snapshot = projectSnapshotSchema.parse(
        await bridge.handle({ op: 'project.state', project_id: projectId }),
      );
      const holdSpy = vi.spyOn(NavisClient.prototype, 'request').mockResolvedValue({
        ...snapshot,
        projection: { ...snapshot.projection, holds: { test: { status: 'active' } } },
      });
      expect(
        await bridge.handle({ op: 'hook.session.start', cwd: dir, request_id: uuidv7() }),
      ).toMatchObject({
        status: 'bound',
        context_summary: { open_hold_count: 1 },
      });
      holdSpy.mockRestore();
      vi.spyOn(NavisClient.prototype, 'request').mockResolvedValue({
        ...snapshot,
        projection: { ...snapshot.projection, project: null },
      });
      expect(
        await bridge.handle({ op: 'hook.session.start', cwd: dir, request_id: uuidv7() }),
      ).toMatchObject({ status: 'unbound' });
      vi.restoreAllMocks();
      const contents = readFileSync(path.join(dir, 'navis.toml'), 'utf8');
      writeFileSync(path.join(dir, 'navis.toml'), contents + '# modified declaration\n');
      await expect(bridge.handle({ op: 'bind', cwd: dir })).rejects.toThrow('binding refused');
      writeFileSync(path.join(dir, 'navis.toml'), contents);
      const db = new DatabaseSync(path.join(bridge.paths.dataDir, 'bridge.sqlite'));
      db.prepare('DELETE FROM runtime_settings WHERE key=?').run(`context:${projectId}`);
      db.close();
      vi.spyOn(NavisClient.prototype, 'request')
        .mockResolvedValueOnce(snapshot)
        .mockRejectedValueOnce(new Error('network dropped'));
      expect(
        await bridge.handle({ op: 'hook.session.start', cwd: dir, request_id: uuidv7() }),
      ).toMatchObject({ status: 'unbound' });
      vi.restoreAllMocks();
    });
    it('supervises background failures and supports explicit shutdown', async () => {
      const original = readFileSync(credentialFile, 'utf8');
      await bridge.handle({
        op: 'capture',
        event_id: uuidv7(),
        cwd: dir,
        step: { kind: 'user.message', body: 'queued' },
        session_id: 'pause',
        privacy: 'metadata',
      });
      const db = new DatabaseSync(path.join(bridge.paths.dataDir, 'bridge.sqlite'));
      db.exec("UPDATE outbox_events SET retry_count=8 WHERE state='pending'");
      db.close();
      const request = vi
        .spyOn(NavisClient.prototype, 'request')
        .mockRejectedValue(new RemoteError(401, 'UNAUTHORIZED'));
      expect(await bridge.sync()).toMatchObject({ paused: true });
      expect(await bridge.sync()).toMatchObject({ paused: true });
      request.mockRestore();
      vi.spyOn(bridge, 'sync').mockRejectedValueOnce(new Error('filesystem unavailable'));
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(await bridge.handle({ op: 'status' })).toMatchObject({
        last_error: 'BRIDGE_SYNC_FAILED',
      });
      writeFileSync(credentialFile, original);
      const completion = Promise.withResolvers<Awaited<ReturnType<BridgeRuntime['sync']>>>();
      const finishing = vi.spyOn(bridge, 'sync').mockReturnValueOnce(completion.promise);
      finishing.mockClear();
      await vi.waitFor(
        () => {
          expect(finishing).toHaveBeenCalled();
        },
        { timeout: 3000 },
      );
      expect(await bridge.handle({ op: 'stop' })).toEqual({ stopping: true });
      await new Promise((resolve) => setTimeout(resolve, 40));
      completion.reject(new Error('late transfer failure during shutdown'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  },
);
