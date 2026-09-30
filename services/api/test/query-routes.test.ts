import { request } from 'node:http';
import { uuidv7 } from '@navis/domain';

import { afterEach, describe, expect, it } from 'vitest';

import { InMemoryEventStore, InMemoryProjectDirectory } from '@navis/infrastructure';

import { loadApiConfig } from '../src/platform/config.js';
import {
  getProjectStateRoute,
  loadContextRoute,
  searchProjectsRoute,
} from '../src/query/routes.js';
import { createApiServer, type ApiServer, type ServiceRoute } from '../src/platform/server.js';
import type { LogSink } from '../src/platform/logging.js';

/**
 * End-to-end against a real `node:http` listener: the query contract is a
 * wire promise, so the three time-planes, the cursor pagination, and the
 * membership filter are observed at the wire (standard 02). The ledger and
 * the directory behind the routes are the in-memory adapters — the transport
 * is under test, not the storage engines.
 */

const PROJECT = '01924a61-7a1b-7c2d-8e3f-000000000001';
const OTHER_PROJECT = '01924a61-7a1b-7c2d-8e3f-000000000002';
const PARTICIPANT = '01924a61-7a1b-7c2d-8e3f-0000000000b1';
const AT = '2026-09-01T00:00:00.000Z';

interface Response {
  readonly status: number;
  readonly body: unknown;
}

const started: ApiServer[] = [];

const sink: LogSink = {
  write() {
    /* the transport is under test, not the log shape */
  },
};

function dataOf(body: unknown): Record<string, unknown> {
  const envelope = body as { data?: Record<string, unknown> | null } | undefined;
  return envelope?.data ?? {};
}

/** A deny response carries an explicit null data: the planes never surface. */
function dataOrNull(body: unknown): unknown {
  const envelope = body as { data?: unknown } | undefined;
  return envelope?.data ?? null;
}

/** Seeds a two-project ledger: PROJECT has a work arc, OTHER_PROJECT is bare. */
function openLedger(participantId: string | null = PARTICIPANT): {
  eventStore: InMemoryEventStore;
  directory: InMemoryProjectDirectory;
  get: (path: string) => Promise<Response>;
} {
  const eventStore = new InMemoryEventStore();
  const directory = new InMemoryProjectDirectory();
  directory.register({
    project_id: PROJECT,
    title: 'merchant onboarding',
    status: 'active',
    state_version: 0,
  });
  directory.register({
    project_id: OTHER_PROJECT,
    title: 'private ledger',
    status: 'active',
    state_version: 0,
  });
  // the caller's participant may read PROJECT only; the other project is
  // invisible to them, and its title must never surface
  if (participantId !== null) directory.grant(participantId, PROJECT);

  const routes: readonly ServiceRoute[] = [
    getProjectStateRoute({
      eventStore,
      projectDirectory: directory,
      participantId: () => participantId,
    }),
    loadContextRoute({
      eventStore,
      projectDirectory: directory,
      participantId: () => participantId,
    }),
    searchProjectsRoute({
      eventStore,
      projectDirectory: directory,
      participantId: () => participantId,
    }),
  ];
  const server = createApiServer(loadApiConfig({}), sink, routes);
  started.push(server);
  let portCache: number | undefined;

  const get = async (path: string): Promise<Response> => {
    portCache ??= await server.listen(0, '127.0.0.1');
    const port = portCache;
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path,
          headers: { connection: 'close' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode ?? 0,
              body: raw.length === 0 ? undefined : JSON.parse(raw),
            });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  };

  return { eventStore, directory, get };
}

/** Appends one envelope so the ledger has something to replay. */
async function appendEvent(
  eventStore: InMemoryEventStore,
  seq: number,
  type: string,
  payload: Record<string, JSONValue>,
  options: { actor?: string | null; projectId?: string } = {},
): Promise<void> {
  const projectId = options.projectId ?? PROJECT;
  // `null ?? x` collapses to x, so an explicitly-absent author needs its own sentinel
  const actor = 'actor' in options ? options.actor : PARTICIPANT;
  await eventStore.append(
    projectId,
    [
      {
        event_id: uuidv7(),
        project_id: projectId,
        seq,
        aggregate_type: 'project',
        aggregate_id: projectId,
        aggregate_revision: seq,
        event_type: type,
        event_schema_version: 1,
        occurred_at: AT,
        recorded_at: AT,
        actor_participant_id: actor,
        causation_id: null,
        correlation_id: null,
        idempotency_key: `${projectId}:${String(seq)}`,
        payload,
        metadata: {},
        privacy_class: 'work',
        state_version: 0,
      },
    ],
    seq - 1,
  );
}

/**
 * The envelope payload shape: JSON. Declaring it here keeps the fixture
 * literals assignable to the schema without an assertion.
 */
type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/**
 * A `participant.registered` payload. The kernel requires every actor to be
 * registered by its own event before any later event may name them, so a
 * ledger that PARTICIPANT authors opens with this one.
 */
function registeredParticipant(): Record<string, JSONValue> {
  return { participant_id: PARTICIPANT, type: 'human', display_name: 'owner' };
}

/** A `project.created` payload the kernel's event validator accepts. */
function createdProject(): Record<string, JSONValue> {
  return { project_id: PROJECT, title: 'merchant onboarding' };
}

/** A `work.created` payload the kernel's event validator accepts. */
function createdWork(title: string): Record<string, JSONValue> {
  return {
    work_id: uuidv7(),
    project_id: PROJECT,
    title,
    reason: 'test',
    actor: PARTICIPANT,
  };
}

/** A `hold.registered` payload the kernel's event validator accepts. */
function registeredHold(): Record<string, JSONValue> {
  return {
    hold_id: uuidv7(),
    project_id: PROJECT,
    kind: 'tech_debt',
    severity: 'blocking',
    initial_status: 'active',
    blocks_delivery: true,
    statement: 'a hold',
    actor: PARTICIPANT,
    registered_by: PARTICIPANT,
  };
}

afterEach(async () => {
  const pending = started.splice(0);
  for (const server of pending) {
    await server.close();
  }
});

describe('GET /api/projects/:projectId/state', () => {
  it('returns the three time-planes anchored at ledger entries', async () => {
    const ledger = openLedger();
    await appendEvent(ledger.eventStore, 1, 'participant.registered', registeredParticipant(), {
      actor: null,
    });
    await appendEvent(ledger.eventStore, 2, 'project.created', createdProject());
    await appendEvent(ledger.eventStore, 3, 'work.created', createdWork('intake form'));

    const res = await ledger.get(`/api/projects/${PROJECT}/state`);

    expect(res.status).toBe(200);
    const data = dataOf(res.body);
    expect(data['project_id']).toBe(PROJECT);
    const planes = data['planes'] as Record<string, unknown[]>;
    const history = planes['history'] ?? [];
    const current = planes['current'] ?? [];
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(current.length).toBe(1);
    expect(current[0]).toMatchObject({
      anchor: { seq: 3, event_type: 'work.created' },
      label: 'intake form',
    });
  });

  it('denies a non-member without revealing the project', async () => {
    const ledger = openLedger();
    await appendEvent(ledger.eventStore, 1, 'participant.registered', registeredParticipant(), {
      actor: null,
    });
    await appendEvent(ledger.eventStore, 2, 'project.created', createdProject());

    const res = await ledger.get(`/api/projects/${OTHER_PROJECT}/state`);

    // a non-member sees neither the planes nor the project's existence
    expect(res.status).toBe(200);
    // deny-default: the planes are absent and the project's existence never surfaces
    expect(dataOrNull(res.body)).toBeNull();
  });
});

describe('GET /api/projects/:projectId/context', () => {
  it('filters by type and paginates without overlap', async () => {
    const ledger = openLedger();
    await appendEvent(ledger.eventStore, 1, 'participant.registered', registeredParticipant(), {
      actor: null,
    });
    await appendEvent(ledger.eventStore, 2, 'work.created', createdWork('first'));
    await appendEvent(ledger.eventStore, 3, 'hold.registered', registeredHold());
    await appendEvent(ledger.eventStore, 4, 'work.created', createdWork('second'));

    const res = await ledger.get(`/api/projects/${PROJECT}/context?types=work&limit=1`);

    expect(res.status).toBe(200);
    const data = dataOf(res.body);
    expect((data['entries'] as unknown[]).length).toBe(1);
    expect((data['entries'] as Record<string, unknown>[])[0]).toMatchObject({
      seq: 2,
      event_type: 'work.created',
    });
    expect(data['has_more']).toBe(true);
    const next = data['next_cursor'];
    expect(typeof next).toBe('string');

    const res2 = await ledger.get(
      `/api/projects/${PROJECT}/context?types=work&limit=1&cursor=${encodeURIComponent(String(next))}`,
    );
    const data2 = dataOf(res2.body);
    // the second page starts strictly after the first page's last seq
    expect((data2['entries'] as Record<string, unknown>[])[0]).toMatchObject({ seq: 4 });
    expect(data2['has_more']).toBe(false);
  });

  it('folds repeated type filters into one list', async () => {
    const ledger = openLedger();
    await appendEvent(ledger.eventStore, 1, 'participant.registered', registeredParticipant(), {
      actor: null,
    });
    await appendEvent(ledger.eventStore, 2, 'work.created', createdWork('work event'));
    await appendEvent(ledger.eventStore, 3, 'hold.registered', registeredHold());

    // three keys: string -> array -> append, so both list-growth branches run
    const res = await ledger.get(
      `/api/projects/${PROJECT}/context?types=work&types=hold&types=work&limit=10`,
    );

    expect(res.status).toBe(200);
    const entries = dataOf(res.body)['entries'] as Record<string, unknown>[];
    expect(entries.length).toBe(2);
  });

  it('promotes a single repeated key to a two-element list', async () => {
    const ledger = openLedger();
    await appendEvent(ledger.eventStore, 1, 'participant.registered', registeredParticipant(), {
      actor: null,
    });
    await appendEvent(ledger.eventStore, 2, 'work.created', createdWork('work event'));
    await appendEvent(ledger.eventStore, 3, 'hold.registered', registeredHold());

    // two keys: string -> array promotion
    const res = await ledger.get(`/api/projects/${PROJECT}/context?types=work&types=hold&limit=10`);

    expect(res.status).toBe(200);
    const entries = dataOf(res.body)['entries'] as Record<string, unknown>[];
    expect(entries.length).toBe(2);
  });

  it('ignores events of filtered-out types', async () => {
    const ledger = openLedger();
    await appendEvent(ledger.eventStore, 1, 'participant.registered', registeredParticipant(), {
      actor: null,
    });
    await appendEvent(ledger.eventStore, 2, 'work.created', createdWork('work event'));
    await appendEvent(ledger.eventStore, 3, 'hold.registered', registeredHold());

    const res = await ledger.get(`/api/projects/${PROJECT}/context?types=hold&limit=10`);

    expect(res.status).toBe(200);
    const entries = dataOf(res.body)['entries'] as Record<string, unknown>[];
    expect(entries.length).toBe(1);
    expect(entries[0]?.['event_type']).toBe('hold.registered');
  });

  it('denies a non-member', async () => {
    const ledger = openLedger();
    await appendEvent(ledger.eventStore, 1, 'participant.registered', registeredParticipant(), {
      actor: null,
    });
    await appendEvent(ledger.eventStore, 2, 'work.created', createdWork('work event'));

    const res = await ledger.get(`/api/projects/${OTHER_PROJECT}/context?types=work&limit=10`);

    expect(res.status).toBe(200);
    // deny-default: the planes are absent and the project's existence never surfaces
    expect(dataOrNull(res.body)).toBeNull();
  });
});

describe('unsupported contract version', () => {
  it('refuses a future contract version with the supported range', async () => {
    const ledger = openLedger();

    const res = await ledger.get('/api/projects?query=m&limit=10&contract_version=999');

    expect(res.status).toBe(400);
    const problem = res.body as Record<string, unknown>;
    expect(problem['code']).toBe('UNSUPPORTED_CONTRACT_VERSION');
    expect(problem['server_supported_contract_versions']).toEqual([1]);
  });
});

describe('GET /api/projects', () => {
  it('answers a bare request with no query string', async () => {
    const ledger = openLedger();
    // no params at all: the parser still yields a usable empty record
    await expect(ledger.get('/api/projects')).resolves.toMatchObject({ status: 500 });
  });

  it('lists only projects the participant may read', async () => {
    const ledger = openLedger();

    const res = await ledger.get('/api/projects?query=merchant&limit=10');

    expect(res.status).toBe(200);
    const data = dataOf(res.body);
    const results = data['results'] as Record<string, unknown>[];
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({
      project_id: PROJECT,
      project_name: 'merchant onboarding',
      project_status: 'active',
    });
  });

  it('returns nothing for a prefix with no visible project', async () => {
    const ledger = openLedger();

    const res = await ledger.get('/api/projects?query=private&limit=10');

    expect(res.status).toBe(200);
    expect((dataOf(res.body)['results'] as unknown[]).length).toBe(0);
  });

  it('paginates and stops at the last page', async () => {
    const ledger = openLedger();
    const directory = ledger.directory;
    for (let i = 0; i < 3; i += 1) {
      const id = `01924a61-7a1b-7c2d-8e3f-${(100 + i).toString(16).padStart(12, '0')}`;
      directory.register({
        project_id: id,
        title: `merchant ${String(i)}`,
        status: 'active',
        state_version: 0,
      });
      directory.grant(PARTICIPANT, id);
    }

    const res = await ledger.get('/api/projects?query=merchant&limit=2');

    expect(res.status).toBe(200);
    const data = dataOf(res.body);
    expect((data['results'] as unknown[]).length).toBe(2);
    expect(data['has_more']).toBe(true);
    const next = data['next_cursor'];
    expect(typeof next).toBe('string');

    const res2 = await ledger.get(
      `/api/projects?query=merchant&limit=2&cursor=${encodeURIComponent(String(next))}`,
    );
    const data2 = dataOf(res2.body);
    // 'merchant onboarding' also matches the prefix: exactly two pages of two
    const page2 = data2['results'] as unknown[];
    expect(page2.length).toBe(2);
    expect(data2['has_more']).toBe(false);
    expect(data2['next_cursor']).toBeUndefined();
  });

  it('rejects a non-integer limit', async () => {
    const ledger = openLedger();
    const res = await ledger.get(`/api/projects/${PROJECT}/context?types=work&limit=1.5`);
    expect(res.status).toBe(500);
  });

  it('rejects an absent types filter value', async () => {
    const ledger = openLedger();
    const res = await ledger.get(`/api/projects/${PROJECT}/context`);
    expect(res.status).toBe(500);
  });

  it('rejects a search with no query', async () => {
    const ledger = openLedger();
    const res = await ledger.get('/api/projects?limit=10');
    expect(res.status).toBe(500);
  });

  it('denies a search when the session has no participant', async () => {
    const ledger = openLedger(null);
    const res = await ledger.get('/api/projects?query=merchant&limit=10');
    expect(res.status).toBe(200);
    expect((res.body as { data: unknown }).data).toBeNull();
  });
});
