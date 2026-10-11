import { getProjectState } from '../src/query/project-query.js';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createConnection,
  runMigrations,
  PostgresProjectWorkspace,
  PostgresAssistanceJobs,
} from '@navis/infrastructure';
import { uuidv7, ProjectStateKernel } from '@navis/domain';
import type { ProjectCommand } from '@navis/contracts';
import { ProjectService, MAX_PROJECT_EVENTS } from '../src/project/project-service.js';
import { provisionDevice } from '../src/auth/provision-device.js';
import { AssistanceService, ModelProviderError } from '../src/assistance/service.js';
const configured = process.env['DATABASE_URL']?.trim();
const databaseUrl = configured === '' ? undefined : configured;
describe.runIf(databaseUrl !== undefined)('project transaction and model orchestration', () => {
  let sql: ReturnType<typeof createConnection> | undefined;
  let admin: ReturnType<typeof createConnection> | undefined;
  const databaseName = `navis_app_${uuidv7().replaceAll('-', '')}`;
  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    admin = createConnection(databaseUrl);
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(databaseUrl);
    url.pathname = `/${databaseName}`;
    sql = createConnection(url.href);
    await runMigrations(sql);
  });
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 0 });
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end({ timeout: 0 });
    }
  });
  async function fixture() {
    if (sql === undefined) throw new Error('explicit database required');
    const workspace = new PostgresProjectWorkspace(sql);
    const now = () => new Date().toISOString();
    const owner = await provisionDevice(workspace, now, 'application owner', 'human');
    const agent = await provisionDevice(workspace, now, 'application agent', 'agent');
    const service = new ProjectService(workspace, now);
    const id = uuidv7();
    await service.create(
      owner.participant_id,
      {
        project_id: id,
        title: 'application project',
        purpose: 'test',
        boundary: 'test only',
        acceptance_criteria: ['human review'],
      },
      uuidv7(),
    );
    return { workspace, service, id, owner: owner.participant_id, agent: agent.participant_id };
  }
  function value(result: Awaited<ReturnType<ProjectService['command']>>): Record<string, unknown> {
    expect(result.status).toBe('applied');
    if (result.status === 'in_flight' || !result.result.ok)
      throw new Error('expected successful command');
    return result.result.value as Record<string, unknown>;
  }
  it('preserves authority across validation failure and rolls back exceptions', async () => {
    const f = await fixture();
    const id = uuidv7();
    expect((await f.service.create(f.owner, { project_id: id, title: ' ' }, uuidv7())).status).toBe(
      'failed',
    );
    await expect(f.service.state(f.owner, id)).rejects.toThrow('unavailable');
    await expect(
      f.service.create(uuidv7(), { project_id: uuidv7(), title: 'unknown' }, uuidv7()),
    ).rejects.toThrow('principal');
    await expect(
      f.service.create(f.owner, { project_id: f.id, title: 'duplicate' }, uuidv7()),
    ).rejects.toThrow('already exists');
    const before = await f.service.state(f.owner, f.id);
    const key = uuidv7();
    vi.spyOn(ProjectStateKernel.prototype, 'currentSeq', 'get')
      .mockReturnValueOnce(MAX_PROJECT_EVENTS + 1)
      .mockReturnValueOnce(MAX_PROJECT_EVENTS + 1);
    await expect(
      f.service.command(
        f.owner,
        f.id,
        { type: 'work.create', title: 'too far', reason: 'limit', expected_version: 0 },
        key,
      ),
    ).rejects.toThrow('limit');
    vi.restoreAllMocks();
    expect((await f.service.state(f.owner, f.id)).ledger_seq).toBe(before.ledger_seq);
    value(
      await f.service.command(
        f.owner,
        f.id,
        {
          type: 'work.create',
          title: 'retry after rollback',
          reason: 'safe retry',
          expected_version: 0,
        },
        key,
      ),
    );
  });
  it('enforces ownership and records participant registration once', async () => {
    const f = await fixture();
    await expect(
      f.service.member(f.agent, f.id, { participant_id: f.owner, action: 'revoke' }, uuidv7()),
    ).rejects.toThrow('not permitted');
    await f.service.member(f.owner, f.id, { participant_id: f.agent, action: 'grant' }, uuidv7());
    const first = await f.service.state(f.owner, f.id);
    await f.service.member(f.owner, f.id, { participant_id: f.agent, action: 'grant' }, uuidv7());
    expect((await f.service.state(f.owner, f.id)).ledger_seq).toBe(first.ledger_seq);
    await expect(
      f.service.command(
        f.agent,
        f.id,
        {
          type: 'work.create',
          title: 'agent cannot direct',
          reason: 'negative',
          expected_version: 0,
        },
        uuidv7(),
      ),
    ).rejects.toThrow('not permitted');
    await f.service.member(f.owner, f.id, { participant_id: f.agent, action: 'revoke' }, uuidv7());
    await expect(
      f.service.authorize(f.agent, f.id, 'assistance.request', 'propose'),
    ).rejects.toThrow('not permitted');
  });
  it('maps project, work, holds, directions and effect recovery through domain policy', async () => {
    const f = await fixture();
    const command = (input: ProjectCommand) => f.service.command(f.owner, f.id, input, uuidv7());
    const work = value(
      await command({
        type: 'work.create',
        title: 'work',
        reason: 'experiment',
        direction: 'initial',
        expected_version: 0,
      }),
    );
    const workId = String(work['id']);
    value(
      await command({
        type: 'work.redirect',
        work_id: workId,
        direction: 'revised',
        reason: 'reviewed',
        create_checkpoint: true,
        expected_version: 0,
      }),
    );
    value(
      await command({
        type: 'project.policy',
        event_count_window: 10,
        time_window_days: 1,
        reason: 'capture policy',
        expected_version: 0,
      }),
    );
    const hold = value(
      await command({
        type: 'hold.register',
        kind: 'tech_debt',
        severity: 'low',
        statement: 'track debt',
        registered_during_work: workId,
        expected_version: 0,
      }),
    );
    value(
      await command({
        type: 'hold.transition',
        hold_id: String(hold['id']),
        to: 'resolved',
        reason: 'resolved',
        expected_version: 0,
      }),
    );
    const directionId = uuidv7();
    value(
      await command({
        type: 'direction.propose',
        direction_id: directionId,
        title: 'next direction',
        detail: 'candidate',
        expected_version: 0,
      }),
    );
    value(
      await command({
        type: 'direction.resolve',
        direction_id: directionId,
        resolution: 'confirmed',
        resolution_reason: 'reviewed',
        expected_version: 0,
      }),
    );
    const effect = value(
      await command({
        type: 'effect.intent',
        intent_key: 'retry-effect',
        description: 'external action',
        expected_version: 0,
      }),
    );
    const effectId = String(effect['id']);
    value(await command({ type: 'effect.begin', effect_id: effectId, expected_version: 0 }));
    value(
      await command({
        type: 'effect.reset',
        effect_id: effectId,
        reason: 'executor crashed',
        expected_version: 0,
      }),
    );
    value(await command({ type: 'effect.begin', effect_id: effectId, expected_version: 0 }));
    value(
      await command({
        type: 'effect.cancel',
        effect_id: effectId,
        reason: 'cancelled while executing',
        expected_version: 0,
      }),
    );
    value(
      await command({
        type: 'effect.close',
        effect_id: effectId,
        outcome: 'failed',
        reason: 'cancelled',
        expected_version: 0,
      }),
    );
    value(
      await command({ type: 'work.cancel', work_id: workId, reason: 'stop', expected_version: 0 }),
    );
    value(
      await command({
        type: 'project.boundary',
        boundary: 'revised boundary',
        acceptance_criteria: ['updated review'],
        reason: 'scope change',
        expected_version: 0,
      }),
    );
    value(
      await command({ type: 'project.status', to: 'paused', reason: 'pause', expected_version: 1 }),
    );
    expect((await f.service.state(f.owner, f.id)).state_version).toBe(2);
    const read = await f.workspace.transaction(f.id, (tx) => getProjectState(tx.events, f.id));
    expect(read.planes.current.length).toBeGreaterThan(1);
    expect(read.planes.intended).toEqual([]);
  });
  it('maps work runs, intervention, return and acceptance without client identity fields', async () => {
    const f = await fixture();
    const command = (input: ProjectCommand) => f.service.command(f.owner, f.id, input, uuidv7());
    const work = value(
      await command({
        type: 'work.create',
        title: 'run work',
        reason: 'work',
        expected_version: 0,
      }),
    );
    const workId = String(work['id']);
    const equip = value(
      await command({ type: 'equip.issue', work_id: workId, expected_version: 0 }),
    );
    const equipId = String(equip['id']);
    const runId = uuidv7();
    value(
      await command({
        type: 'run.start',
        run_id: runId,
        work_id: workId,
        equip_id: equipId,
        execution_refs: { local: 'run-a' },
        expected_version: 0,
      }),
    );
    let row = (await f.service.state(f.owner, f.id)).projection.work_runs[runId];
    if (!row) throw new Error('run missing');
    if (row.status === 'ready')
      value(
        await command({
          type: 'run.transition',
          run_id: runId,
          to: 'running',
          reason: 'start',
          run_revision: row.run_revision,
          expected_version: 0,
        }),
      );
    row = (await f.service.state(f.owner, f.id)).projection.work_runs[runId];
    if (!row) throw new Error('run missing');
    expect(
      (
        await command({
          type: 'run.transition',
          run_id: runId,
          to: 'running',
          reason: 'duplicate start rejected',
          run_revision: row.run_revision,
          expected_version: 0,
        })
      ).status,
    ).toBe('failed');
    const sessionId = uuidv7();
    value(
      await command({
        type: 'intervention.open',
        run_id: runId,
        session_id: sessionId,
        mode: 'observe',
        run_revision: row.run_revision,
        expected_version: 0,
      }),
    );
    row = (await f.service.state(f.owner, f.id)).projection.work_runs[runId];
    if (!row) throw new Error('run missing');
    value(
      await command({
        type: 'intervention.close',
        run_id: runId,
        session_id: sessionId,
        run_revision: row.run_revision,
        expected_version: 0,
      }),
    );
    value(
      await command({
        type: 'return.submit',
        equip_id: equipId,
        candidates: [
          {
            kind: 'knowledge',
            provenance: 'reviewed source',
            content: { storage: 'inline', media_type: 'text/plain', text: 'draft' },
          },
        ],
        effects: [{ description: 'unresolved' }],
        expected_version: 0,
      }),
    );
    const asset = Object.values((await f.service.state(f.owner, f.id)).projection.assets)[0];
    if (!asset) throw new Error('asset missing');
    value(
      await command({
        type: 'asset.accept',
        asset_id: asset.id,
        result: 'accepted',
        criteria_snapshot: { review: 'human' },
        evidence_refs: [],
        expected_version: 0,
      }),
    );
    value(
      await command({
        type: 'asset.transition',
        asset_id: asset.id,
        to: 'archived',
        reason: 'retire',
        expected_version: 0,
      }),
    );
  });
  it('reads a complete public projection with current run labels', async () => {
    const f = await fixture();
    const work = value(
      await f.service.command(
        f.owner,
        f.id,
        { type: 'work.create', title: 'query work', reason: 'query', expected_version: 0 },
        uuidv7(),
      ),
    );
    const equip = value(
      await f.service.command(
        f.owner,
        f.id,
        { type: 'equip.issue', work_id: String(work['id']), expected_version: 0 },
        uuidv7(),
      ),
    );
    await f.service.command(
      f.owner,
      f.id,
      {
        type: 'run.start',
        run_id: uuidv7(),
        work_id: String(work['id']),
        equip_id: String(equip['id']),
        expected_version: 0,
      },
      uuidv7(),
    );
    await f.service.command(
      f.owner,
      f.id,
      {
        type: 'asset.propose',
        kind: 'knowledge',
        content: { media_type: 'text/plain', storage: 'inline', text: 'visible' },
        expected_version: 0,
      },
      uuidv7(),
    );
    const read = await f.workspace.transaction(f.id, (tx) => getProjectState(tx.events, f.id));
    expect(Object.keys(read.projection?.assets ?? {})).toHaveLength(1);
    expect(read.planes.current).toHaveLength(2);
  });
  it('records and confirms delivery only for accepted content', async () => {
    const f = await fixture();
    const text = 'deliverable';
    const asset = value(
      await f.service.command(
        f.owner,
        f.id,
        {
          type: 'asset.propose',
          kind: 'artifact',
          expected_version: 0,
          content: {
            media_type: 'text/plain',
            storage: 'inline',
            text,
            sha256: createHash('sha256').update(text).digest('hex'),
          },
        },
        uuidv7(),
      ),
    );
    const assetId = String(asset['id']);
    await f.service.command(
      f.owner,
      f.id,
      {
        type: 'asset.accept',
        asset_id: assetId,
        result: 'accepted',
        criteria_snapshot: { review: 'done' },
        expected_version: 0,
      },
      uuidv7(),
    );
    const delivered = value(
      await f.service.command(
        f.owner,
        f.id,
        {
          type: 'delivery.record',
          asset_id: assetId,
          target_ref: 'local verification',
          target_type: 'staging',
          expected_version: 0,
        },
        uuidv7(),
      ),
    );
    value(
      await f.service.command(
        f.owner,
        f.id,
        {
          type: 'delivery.confirm',
          delivery_id: String(delivered['id']),
          outcome: 'confirmed',
          expected_version: 0,
        },
        uuidv7(),
      ),
    );
    const snapshot = await f.service.state(f.owner, f.id);
    expect(Object.values(snapshot.projection.deliveries)[0]?.confirmation_status).toBe('confirmed');
  });
  it('refuses excessive replay before reading the event body', async () => {
    const f = await fixture();
    const service = new ProjectService(
      {
        transaction: (scope, operation) =>
          f.workspace.transaction(scope, (tx) => {
            vi.spyOn(tx.events, 'headSeq').mockResolvedValue(MAX_PROJECT_EVENTS + 1);
            return operation(tx);
          }),
      },
      () => new Date().toISOString(),
    );
    await expect(service.state(f.owner, f.id)).rejects.toThrow('replay limit');
  });
  it('handles expired model leases, stale project versions and invalid lease records', async () => {
    const f = await fixture();
    if (!sql) throw new Error('database required');
    const jobs = new PostgresAssistanceJobs(sql);
    const model = { generate: vi.fn<() => Promise<string>>().mockResolvedValue('candidate') };
    const service = new AssistanceService(jobs, f.service, model);
    const stale = await service.submit(f.owner, f.id, uuidv7(), {
      prompt: 'stale task',
      expected_version: 99,
    });
    await service.tick(new AbortController().signal);
    expect(await jobs.get(stale.job_id)).toMatchObject({
      status: 'failed',
      error: 'MODEL_CANDIDATE_REJECTED',
    });
    const expired = await service.submit(f.owner, f.id, uuidv7(), {
      prompt: 'expired task',
      expected_version: 0,
    });
    await sql`UPDATE assistance_jobs SET attempts=3,status='running',lease_until=now()-interval '1 second' WHERE id=${expired.job_id}`;
    await service.tick(new AbortController().signal);
    expect(await jobs.get(expired.job_id)).toMatchObject({
      status: 'failed',
      error: 'MODEL_RETRY_EXHAUSTED',
    });
    const record = await jobs.get(expired.job_id);
    if (record === null) throw new Error('job missing');
    vi.spyOn(jobs, 'claim').mockResolvedValueOnce({ ...record, claim: null });
    await expect(service.tick(new AbortController().signal)).rejects.toThrow('lease');
    const lost = await service.submit(f.owner, f.id, uuidv7(), {
      prompt: 'lost lease',
      expected_version: 0,
    });
    vi.spyOn(jobs, 'generated').mockResolvedValueOnce(false);
    await service.tick(new AbortController().signal);
    expect(Object.keys((await f.service.state(f.owner, f.id)).projection.assets)).toHaveLength(0);
    await sql`UPDATE assistance_jobs SET status='failed' WHERE id=${lost.job_id}`;
  });
  it('keeps a durable model result as candidate material and handles denial safely', async () => {
    const f = await fixture();
    if (!sql) throw new Error('database required');
    const jobs = new PostgresAssistanceJobs(sql);
    const model = {
      generate: vi.fn<() => Promise<string>>().mockResolvedValue('candidate output'),
    };
    const service = new AssistanceService(jobs, f.service, model);
    const job = await service.submit(f.owner, f.id, uuidv7(), {
      prompt: 'propose one fact',
      expected_version: 0,
    });
    await service.tick(new AbortController().signal);
    expect((await service.status(f.owner, f.id, job.job_id)).status).toBe('completed');
    expect(await service.tick(new AbortController().signal)).toBe(false);
    expect(
      Object.values((await f.service.state(f.owner, f.id)).projection.assets)[0]?.lifecycle,
    ).toBe('candidate');
    await expect(service.status(f.owner, f.id, uuidv7())).rejects.toThrow('unavailable');
    model.generate.mockRejectedValue(new ModelProviderError('MODEL_CREDENTIAL_DENIED'));
    const denied = await service.submit(f.owner, f.id, uuidv7(), {
      prompt: 'denied',
      expected_version: 0,
    });
    await service.tick(new AbortController().signal);
    expect((await jobs.get(denied.job_id))?.status).toBe('failed');
  });
  it('keeps automatic capture and model tasks local under a governed privacy policy', async () => {
    const f = await fixture();
    if (!sql) throw new Error('database required');
    await f.service.command(
      f.owner,
      f.id,
      {
        type: 'project.policy',
        capture_privacy: 'local-only',
        reason: 'confidential',
        expected_version: 0,
      },
      uuidv7(),
    );
    expect(await f.service.canCapture(f.owner, f.id)).toBe(false);
    const jobs = new PostgresAssistanceJobs(sql);
    const model = { generate: vi.fn<() => Promise<string>>().mockResolvedValue('forbidden') };
    const service = new AssistanceService(jobs, f.service, model);
    await expect(
      service.submit(f.owner, f.id, uuidv7(), { prompt: 'must not leave', expected_version: 0 }),
    ).rejects.toThrow('keeps data local');
    const job = await jobs.submit(f.id, f.owner, uuidv7(), {
      prompt: 'queued before policy change',
      expected_version: 0,
    });
    await service.tick(new AbortController().signal);
    expect(model.generate).not.toHaveBeenCalled();
    expect((await jobs.get(job.id))?.status).toBe('failed');
  });
});
