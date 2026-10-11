import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { uuidv7, ProjectStateKernel } from '@navis/domain';
import {
  AssistanceService,
  ModelProviderError,
  ProjectService,
  provisionDevice,
} from '@navis/application';
import { createConnection, runMigrations } from '../src/persistence/postgres/connection.js';
import { PostgresProjectWorkspace } from '../src/persistence/postgres/postgres-project-workspace.js';
import { PostgresAssistanceJobs } from '../src/persistence/postgres/postgres-assistance-jobs.js';
const configured = process.env['DATABASE_URL']?.trim();
const databaseUrl = configured === '' ? undefined : configured;
describe.runIf(databaseUrl !== undefined)('durable model assistance', () => {
  let sql: ReturnType<typeof createConnection> | undefined;
  let admin: ReturnType<typeof createConnection> | undefined;
  const databaseName = `navis_jobs_${uuidv7().replaceAll('-', '')}`;
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
  function store() {
    if (sql === undefined) throw new Error('explicit database required');
    return new PostgresAssistanceJobs(sql);
  }
  async function fixture() {
    if (sql === undefined) throw new Error('explicit database required');
    const workspace = new PostgresProjectWorkspace(sql);
    const now = () => new Date().toISOString();
    const actor = await provisionDevice(workspace, now, 'model test owner', 'human');
    const projects = new ProjectService(workspace, now);
    const projectId = uuidv7();
    await projects.create(
      actor.participant_id,
      { project_id: projectId, title: 'model job project' },
      uuidv7(),
    );
    const jobs = store();
    const model = {
      generate: vi
        .fn<(_prompt: string, _id: string, _signal: AbortSignal) => Promise<string>>()
        .mockResolvedValue('candidate text'),
    };
    return {
      projects,
      jobs,
      model,
      actor: actor.participant_id,
      projectId,
      service: new AssistanceService(jobs, projects, model),
    };
  }
  it('deduplicates submissions, validates identity and completes a leased job', async () => {
    const jobs = store();
    const projectId = uuidv7();
    const actor = uuidv7();
    const key = uuidv7();
    const request = { prompt: 'a task', expected_version: 0 };
    const created = await jobs.submit(projectId, actor, key, request);
    expect((await jobs.submit(projectId, actor, key, request)).id).toBe(created.id);
    await expect(jobs.submit(projectId, uuidv7(), key, request)).rejects.toThrow('collides');
    expect(await jobs.get(uuidv7())).toBeNull();
    const claimed = await jobs.claim();
    expect(claimed?.id).toBe(created.id);
    if (claimed?.claim == null) throw new Error('lease missing');
    expect(await jobs.generated(created.id, uuidv7(), 'wrong owner', 'test-model')).toBe(false);
    expect(await jobs.generated(created.id, claimed.claim, 'draft', 'test-model')).toBe(true);
    await jobs.complete(created.id, claimed.claim, { candidate: 'recorded' });
    expect(await jobs.get(created.id)).toMatchObject({
      status: 'completed',
      output: 'draft',
      result: { candidate: 'recorded' },
    });
    expect(await jobs.claim()).toBeNull();
  });
  it('materializes model output only as a candidate and replays the same request', async () => {
    const f = await fixture();
    const key = uuidv7();
    const submitted = await f.service.submit(f.actor, f.projectId, key, {
      prompt: 'propose knowledge',
      expected_version: 0,
    });
    expect(
      (
        await f.service.submit(f.actor, f.projectId, key, {
          prompt: 'propose knowledge',
          expected_version: 0,
        })
      ).job_id,
    ).toBe(submitted.job_id);
    expect(await f.service.tick(new AbortController().signal)).toBe(true);
    expect(await f.service.tick(new AbortController().signal)).toBe(false);
    const result = await f.service.status(f.actor, f.projectId, submitted.job_id);
    expect(result.status).toBe('completed');
    const snapshot = await f.projects.state(f.actor, f.projectId);
    expect(Object.values(snapshot.projection.assets)).toHaveLength(1);
    expect(Object.values(snapshot.projection.assets)[0]).toMatchObject({
      lifecycle: 'candidate',
      content: { text: 'candidate text' },
    });
    expect(f.model.generate).toHaveBeenCalledOnce();
    await expect(f.service.status(f.actor, f.projectId, uuidv7())).rejects.toThrow('unavailable');
  });
  it('reuses saved generation and committed command after a completion-write failure', async () => {
    const f = await fixture();
    const job = await f.service.submit(f.actor, f.projectId, uuidv7(), {
      prompt: 'recover this task',
      expected_version: 0,
    });
    vi.spyOn(f.jobs, 'complete').mockRejectedValueOnce(new Error('storage connection lost'));
    await f.service.tick(new AbortController().signal);
    expect(await f.jobs.get(job.job_id)).toMatchObject({
      status: 'pending',
      output: 'candidate text',
    });
    if (sql === undefined) throw new Error('database required');
    await sql`UPDATE assistance_jobs SET available_at=now() WHERE id=${job.job_id}`;
    await f.service.tick(new AbortController().signal);
    expect((await f.jobs.get(job.job_id))?.status).toBe('completed');
    expect(f.model.generate).toHaveBeenCalledOnce();
    expect(
      Object.keys((await f.projects.state(f.actor, f.projectId)).projection.assets),
    ).toHaveLength(1);
  });
  it('suspends credential failures without creating candidate authority', async () => {
    const f = await fixture();
    f.model.generate.mockRejectedValue(new ModelProviderError('MODEL_CREDENTIAL_DENIED'));
    const job = await f.service.submit(f.actor, f.projectId, uuidv7(), {
      prompt: 'denied',
      expected_version: 0,
    });
    await f.service.tick(new AbortController().signal);
    expect(await f.jobs.get(job.job_id)).toMatchObject({
      status: 'failed',
      error: 'MODEL_CREDENTIAL_DENIED',
    });
    expect(
      Object.keys((await f.projects.state(f.actor, f.projectId)).projection.assets),
    ).toHaveLength(0);
  });
  it('retains a retryable task and abandons expired work after the retry budget', async () => {
    const f = await fixture();
    f.model.generate.mockRejectedValue(new ModelProviderError('MODEL_UNAVAILABLE', true));
    const job = await f.service.submit(f.actor, f.projectId, uuidv7(), {
      prompt: 'retry bounded',
      expected_version: 0,
    });
    await f.service.tick(new AbortController().signal);
    expect((await f.jobs.get(job.job_id))?.status).toBe('pending');
    expect(await f.service.tick(new AbortController().signal)).toBe(false);
    if (sql === undefined) throw new Error('database required');
    await sql`UPDATE assistance_jobs SET attempts=3,status='running',lease_until=now()-interval '1 second' WHERE id=${job.job_id}`;
    await f.service.tick(new AbortController().signal);
    expect(await f.jobs.get(job.job_id)).toMatchObject({
      status: 'failed',
      error: 'MODEL_RETRY_EXHAUSTED',
    });
    expect(f.model.generate).toHaveBeenCalledOnce();
  });
  it('validates stored job data and the transaction port handles missing identities and revocation', async () => {
    const f = await fixture();
    if (!sql) throw new Error('database required');
    const workspace = new PostgresProjectWorkspace(sql);
    const agent = await provisionDevice(
      workspace,
      () => new Date().toISOString(),
      'revoked member',
      'agent',
    );
    await f.projects.member(
      f.actor,
      f.projectId,
      { participant_id: agent.participant_id, action: 'grant' },
      uuidv7(),
    );
    await f.projects.member(
      f.actor,
      f.projectId,
      { participant_id: agent.participant_id, action: 'revoke' },
      uuidv7(),
    );
    expect(
      await workspace.transaction(f.projectId, (tx) =>
        tx.membership(f.projectId, agent.participant_id),
      ),
    ).toBeNull();
    expect(await workspace.transaction(f.projectId, (tx) => tx.principal(uuidv7()))).toBeNull();
    await workspace.transaction(f.projectId, (tx) =>
      tx.saveDirectory(new ProjectStateKernel().projection),
    );
    const job = await f.jobs.submit(f.projectId, f.actor, uuidv7(), {
      prompt: 'corrupt record',
      expected_version: 0,
    });
    await sql`UPDATE assistance_jobs SET request='{}',status='failed' WHERE id=${job.id}`;
    await expect(f.jobs.get(job.id)).rejects.toThrow('invalid stored');
  });
  it('enforces a queue budget atomically while still replaying accepted identities', async () => {
    if (!sql) throw new Error('database required');
    const jobs = new PostgresAssistanceJobs(sql, 10000, 1);
    const projectId = uuidv7();
    const actor = uuidv7();
    const key = uuidv7();
    const request = { prompt: 'reserved', expected_version: 0 };
    const first = await jobs.submit(projectId, actor, key, request);
    expect((await jobs.submit(projectId, actor, key, request)).id).toBe(first.id);
    await expect(jobs.submit(projectId, actor, uuidv7(), request)).rejects.toThrow('capacity');
    const claimed = await jobs.claim();
    if (claimed?.claim == null) throw new Error('lease missing');
    await jobs.fail(claimed.id, claimed.claim, 'test complete', false);
    await expect(
      new PostgresAssistanceJobs(sql, 1, 1000).submit(projectId, actor, uuidv7(), request),
    ).rejects.toThrow('capacity');
  });
  it('refuses a job when the database suppresses insertion instead of returning a durable record', async () => {
    if (!sql) throw new Error('database required');
    await sql.unsafe(
      `CREATE FUNCTION suppress_assistance_test() RETURNS trigger AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql`,
    );
    await sql.unsafe(
      `CREATE TRIGGER suppress_assistance_test BEFORE INSERT ON assistance_jobs FOR EACH ROW EXECUTE FUNCTION suppress_assistance_test()`,
    );
    const id = uuidv7();
    try {
      await expect(
        store().submit(id, uuidv7(), uuidv7(), { prompt: 'suppressed', expected_version: 0 }),
      ).rejects.toThrow('insertion returned no row');
      expect(await sql`SELECT id FROM assistance_jobs WHERE project_id=${id}`).toHaveLength(0);
    } finally {
      await sql.unsafe('DROP TRIGGER suppress_assistance_test ON assistance_jobs');
      await sql.unsafe('DROP FUNCTION suppress_assistance_test()');
    }
  });
});
