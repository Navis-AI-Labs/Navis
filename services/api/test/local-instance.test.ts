import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, canonicalJson } from '@navis/domain';
import {
  projectSnapshotSchema,
  searchProjectsResponseSchema,
  type DeviceCredential,
  type ProjectCommand,
} from '@navis/contracts';
import { createApiRuntime, type ApiRuntime } from '../src/platform/composition.js';
import { loadApiConfig } from '../src/platform/config.js';

const databaseUrl =
  process.env['DATABASE_URL']?.trim() === '' ? undefined : process.env['DATABASE_URL']?.trim();
describe.runIf(databaseUrl !== undefined)('durable local instance over HTTP', () => {
  let runtime: ApiRuntime;
  let remote: string;
  let human: DeviceCredential;
  let agent: DeviceCredential;
  let outsider: DeviceCredential;
  const logs: string[] = [];
  beforeAll(async () => {
    runtime = await createApiRuntime(
      { ...loadApiConfig({ DATABASE_URL: databaseUrl }), port: 0 },
      { write: (line) => logs.push(line) },
    );
    if (runtime.provision === undefined) throw new Error('durable project service required');
    human = await runtime.provision('operator', 'human');
    agent = await runtime.provision('agent', 'agent');
    outsider = await runtime.provision('outsider', 'agent');
    remote = `http://127.0.0.1:${String(await runtime.listen())}`;
  });
  afterAll(async () => {
    await runtime.close();
  });
  async function call(
    method: string,
    path: string,
    credential: DeviceCredential,
    body?: unknown,
    key: string = uuidv7(),
  ) {
    const response = await fetch(`${remote}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credential.key_id}.${credential.key_secret}`,
        'content-type': 'application/json',
        connection: 'close',
        'idempotency-key': key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json()) as {
      data: Record<string, unknown>;
      code?: string;
      detail?: string;
    };
    return { status: response.status, body: json };
  }
  function value(reply: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
    expect(reply.status).toBe(200);
    const result = reply.body.data['result'] as { ok: boolean; value: Record<string, unknown> };
    expect(result.ok).toBe(true);
    return result.value;
  }
  async function create() {
    const id = uuidv7();
    value(
      await call('POST', '/api/projects', human, { project_id: id, title: 'integration project' }),
    );
    return id;
  }
  async function state(id: string, credential = human) {
    const reply = await call('GET', `/api/projects/${id}/snapshot`, credential);
    expect(reply.status).toBe(200);
    return projectSnapshotSchema.parse(reply.body.data);
  }
  async function command(id: string, body: ProjectCommand, credential = human, key?: string) {
    return call(
      'POST',
      `/api/projects/${id}/commands`,
      credential,
      { command: body },
      key ?? uuidv7(),
    );
  }

  it('creates once, rejects conflicting identities and scopes every read', async () => {
    const id = uuidv7();
    const key = uuidv7();
    const input = { project_id: id, title: 'created once' };
    expect((await call('POST', '/api/projects', human, input, key)).status).toBe(200);
    const replay = await call('POST', '/api/projects', human, input, key);
    expect(replay.body.data['replayed']).toBe(true);
    expect((await state(id)).ledger_seq).toBe(2);
    expect((await call('POST', '/api/projects', outsider, input, key)).status).toBe(409);
    expect(
      (await call('POST', '/api/projects', human, { ...input, title: 'changed' }, key)).status,
    ).toBe(409);
    expect((await call('POST', '/api/projects', human, input)).status).toBe(409);
    expect((await call('GET', `/api/projects/${id}/snapshot`, outsider)).status).toBe(403);
    const listed = await call('GET', '/api/projects?query=created&limit=10', human);
    expect(listed.status).toBe(200);
  });

  it('lists persisted project identities that open correctly and continue across pages', async () => {
    const prefix = `directory-${uuidv7()}`;
    const firstId = uuidv7();
    const secondId = uuidv7();
    value(
      await call('POST', '/api/projects', human, { project_id: firstId, title: `${prefix} a` }),
    );
    value(
      await call('POST', '/api/projects', human, { project_id: secondId, title: `${prefix} b` }),
    );
    const first = searchProjectsResponseSchema.parse(
      (await call('GET', `/api/projects?query=${prefix}&limit=1`, human)).body.data,
    );
    expect(first.results.map((project) => project.project_id)).toEqual([firstId]);
    expect(first.has_more).toBe(true);
    expect((await state(firstId)).project_id).toBe(firstId);
    if (!first.next_cursor) throw new Error('next page cursor missing');
    const second = searchProjectsResponseSchema.parse(
      (
        await call(
          'GET',
          `/api/projects?query=${prefix}&limit=1&cursor=${first.next_cursor}`,
          human,
        )
      ).body.data,
    );
    expect(second.results.map((project) => project.project_id)).toEqual([secondId]);
    expect(second.has_more).toBe(false);
    expect((await state(secondId)).project_id).toBe(secondId);
  });

  it('rejects malformed commands and missing idempotency before mutation', async () => {
    const id = await create();
    const before = await state(id);
    expect(
      (
        await command(id, {
          type: 'work.create',
          title: 'work',
          reason: 'test',
          expected_version: 99,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('POST', `/api/projects/${id}/commands`, human, {
          command: {
            type: 'work.create',
            title: 'work',
            reason: 'test',
            expected_version: 0,
            actor: outsider.participant_id,
          },
        })
      ).status,
    ).toBe(400);
    const response = await fetch(`${remote}/api/projects`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${human.key_id}.${human.key_secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ project_id: uuidv7(), title: 'no identity' }),
    });
    expect(response.status).toBe(400);
    expect((await state(id)).ledger_seq).toBe(before.ledger_seq);
  });

  it('runs work, return, human acceptance and delivery while unresolved execution blocks delivery', async () => {
    const id = await create();
    value(
      await call('POST', `/api/projects/${id}/members`, human, {
        participant_id: agent.participant_id,
        action: 'grant',
      }),
    );
    const work = value(
      await command(id, {
        type: 'work.create',
        title: 'first work',
        reason: 'experiment',
        expected_version: 0,
      }),
    );
    const equip = value(
      await command(
        id,
        { type: 'equip.issue', work_id: String(work['id']), expected_version: 0 },
        agent,
      ),
    );
    expect(equip['allowed_proposals']).toContain('return.submit');
    expect(equip['allowed_executions']).not.toContain('asset.accept');
    const text = 'reviewable output';
    const hash = createHash('sha256').update(text).digest('hex');
    value(
      await command(
        id,
        {
          type: 'return.submit',
          equip_id: String(equip['id']),
          expected_version: 0,
          candidates: [
            {
              kind: 'artifact',
              content: { media_type: 'text/plain', storage: 'inline', text, sha256: hash },
            },
          ],
        },
        agent,
      ),
    );
    const snapshot = await state(id);
    const asset = Object.values(snapshot.projection.assets)[0];
    if (asset === undefined) throw new Error('candidate missing');
    const assetId = asset['id'];
    if (typeof assetId !== 'string') throw new Error('asset identity missing');
    expect(asset['lifecycle']).toBe('candidate');
    const acceptance = {
      type: 'asset.accept' as const,
      asset_id: assetId,
      result: 'accepted' as const,
      criteria_snapshot: { review: 'human' },
      expected_version: 0,
    };
    expect((await command(id, acceptance, agent)).status).toBe(403);
    value(await command(id, acceptance));
    const effect = value(
      await command(
        id,
        {
          type: 'effect.intent',
          asset_ref: assetId,
          intent_key: 'external-action',
          expected_version: 0,
        },
        agent,
      ),
    );
    value(
      await command(
        id,
        { type: 'effect.begin', effect_id: String(effect['id']), expected_version: 0 },
        agent,
      ),
    );
    expect(
      (
        await command(id, {
          type: 'delivery.record',
          asset_id: assetId,
          target_ref: 'test-target',
          target_type: 'staging',
          expected_version: 0,
        })
      ).status,
    ).toBe(409);
    value(
      await command(
        id,
        {
          type: 'effect.close',
          effect_id: String(effect['id']),
          outcome: 'confirmed',
          expected_version: 0,
        },
        agent,
      ),
    );
    const delivery = value(
      await command(id, {
        type: 'delivery.record',
        asset_id: assetId,
        target_ref: 'test-target',
        target_type: 'staging',
        expected_version: 0,
      }),
    );
    value(
      await command(id, {
        type: 'delivery.confirm',
        delivery_id: String(delivery['id']),
        outcome: 'confirmed',
        expected_version: 0,
      }),
    );
    expect(Object.values((await state(id)).projection.deliveries)[0]?.['confirmation_status']).toBe(
      'confirmed',
    );
    value(
      await call('POST', `/api/projects/${id}/members`, human, {
        participant_id: agent.participant_id,
        action: 'revoke',
      }),
    );
    expect((await call('GET', `/api/projects/${id}/snapshot`, agent)).status).toBe(403);
  });

  it('serializes racing idempotent submissions and advances cursors without a business-version change', async () => {
    const id = await create();
    const key = uuidv7();
    const payload = {
      type: 'work.create' as const,
      title: 'one work',
      reason: 'retry',
      expected_version: 0,
    };
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => command(id, payload, human, key)),
    );
    replies.forEach((reply) => {
      expect(reply.status).toBe(200);
    });
    expect(replies.filter((reply) => reply.body.data['replayed'] === false)).toHaveLength(1);
    const snapshot = await state(id);
    expect(Object.keys(snapshot.projection.works)).toHaveLength(1);
    expect(snapshot.state_version).toBe(0);
    expect(snapshot.ledger_seq).toBe(3);
  });

  it('keeps owner membership protected and rejects unknown principals', async () => {
    const id = await create();
    expect(
      (
        await call('POST', `/api/projects/${id}/members`, human, {
          participant_id: human.participant_id,
          action: 'revoke',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/projects/${id}/members`, human, {
          participant_id: uuidv7(),
          action: 'grant',
        })
      ).status,
    ).toBe(403);
  });

  it('never includes device secrets or raw query strings in request logs', async () => {
    await call('GET', '/api/devices?credential=synthetic-secret', human);
    expect(logs.join('\n')).not.toContain(human.key_secret);
    expect(logs.join('\n')).not.toContain('synthetic-secret');
  });
  it('rechecks capture policy during authenticated ingest and attributes the collector', async () => {
    const id = await create();
    const event = {
      schema_version: 1,
      event_type: 'user.message',
      occurred_at: new Date().toISOString(),
      project_id: id,
      source_runtime: 'http-test',
      source_session_id: 'session',
      raw_ref: 'session://test',
      extractor_version: '1',
      confidence: 1,
      review_status: 'pending',
      payload: { privacy: { char_length: 7, sha256: 'a'.repeat(64) } },
    };
    const batch = () => ({
      contract_version: 1,
      event_schema_version: 1,
      device_id: human.device_id,
      events: [
        {
          event_id: uuidv7(),
          event,
          payload_hash: {
            algorithm: 'sha256',
            value: createHash('sha256').update(canonicalJson(event)).digest('hex'),
          },
        },
      ],
    });
    const accepted = await call('POST', '/api/ingest', human, batch());
    expect(accepted.status).toBe(200);
    expect(accepted.body.data['accepted'], JSON.stringify(accepted.body.data)).toEqual([0]);
    value(
      await command(id, {
        type: 'project.policy',
        capture_privacy: 'local-only',
        reason: 'privacy',
        expected_version: 0,
      }),
    );
    const before = await state(id);
    const refused = await call('POST', '/api/ingest', human, batch());
    expect(refused.body.data['rejected']).toEqual([
      { index: 0, token: 'ingest/authorization-denied' },
    ]);
    expect((await state(id)).ledger_seq).toBe(before.ledger_seq);
  });
});
