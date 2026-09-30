import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@navis/domain';
import { InMemoryEventStore, InMemoryProjectDirectory } from '@navis/infrastructure';

import { getProjectState, loadContext, searchProjects } from '../src/query/project-query.js';

/**
 * Use-case suite: the query read face against the in-memory adapters. The
 * route suite proves the same behavior at the wire (standard 02); this suite
 * pins every branch the transport cannot reach cheaply — cursor round-trips,
 * filter intersection, replay identity, and the membership filter.
 */

const PROJECT = '01924a61-7a1b-7c2d-8e3f-000000000001';
const PARTICIPANT = '01924a61-7a1b-7c2d-8e3f-0000000000b1';
const OTHER_PARTICIPANT = '01924a61-7a1b-7c2d-8e3f-0000000000b2';
const AT = '2026-09-01T00:00:00.000Z';

interface EventSpec {
  readonly type: string;
  readonly payload: Record<string, JSONValue>;
  readonly actor?: string | null;
}

/** The envelope payload shape: JSON, so the fixture literals stay assignable. */
type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | {
      [key: string]: JSONValue;
    };

/** Appends one event; the payload satisfies the kernel's event validator. */
async function append(store: InMemoryEventStore, seq: number, spec: EventSpec): Promise<void> {
  await store.append(
    PROJECT,
    [
      {
        event_id: uuidv7(),
        project_id: PROJECT,
        seq,
        aggregate_type: 'project',
        aggregate_id: PROJECT,
        aggregate_revision: seq,
        event_type: spec.type,
        event_schema_version: 1,
        occurred_at: AT,
        recorded_at: AT,
        actor_participant_id: spec.actor === undefined ? PARTICIPANT : spec.actor,
        causation_id: null,
        correlation_id: null,
        idempotency_key: `${PROJECT}:${String(seq)}`,
        payload: spec.payload,
        metadata: {},
        privacy_class: 'work',
        state_version: 0,
      },
    ],
    seq - 1,
  );
}

/** A ledger with the participant registered so later events may name them. */
async function seededStore(): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  await append(store, 1, {
    type: 'participant.registered',
    payload: { participant_id: PARTICIPANT, type: 'human', display_name: 'owner' },
    actor: null,
  });
  return store;
}

function directory(): InMemoryProjectDirectory {
  const d = new InMemoryProjectDirectory();
  d.register({
    project_id: PROJECT,
    title: 'merchant onboarding',
    status: 'active',
    state_version: 3,
  });
  d.grant(PARTICIPANT, PROJECT);
  return d;
}

describe('getProjectState', () => {
  it('replays the ledger into three planes anchored at their entries', async () => {
    const store = await seededStore();
    await append(store, 2, {
      type: 'project.created',
      payload: { project_id: PROJECT, title: 'merchant onboarding' },
    });
    await append(store, 3, {
      type: 'work.created',
      payload: {
        work_id: uuidv7(),
        project_id: PROJECT,
        title: 'intake form',
        reason: 'onboarding step',
        actor: PARTICIPANT,
      },
    });

    const state = await getProjectState(store, PROJECT);

    expect(state.project_id).toBe(PROJECT);
    expect(state.change_marker).toBe('advanced');
    // history: the participant + project arc; policy churn excluded
    expect(state.planes.history.map((h) => h.anchor.event_type)).toEqual([
      'participant.registered',
      'project.created',
    ]);
    // current: the live work/hold surface
    expect(state.planes.current.map((c) => c.anchor.event_type)).toEqual(['work.created']);
    expect(state.planes.current[0]?.label).toBe('intake form');
    expect(state.planes.intended).toEqual([]);
  });

  it('rebuilds the same state_version the kernel computes', async () => {
    const store = await seededStore();
    await append(store, 2, {
      type: 'project.created',
      payload: { project_id: PROJECT, title: 'merchant onboarding' },
    });

    const state = await getProjectState(store, PROJECT);

    // no State-material event in this log, so the version stays 0
    expect(state.state_version).toBe(0);
  });

  it('places direction proposals in the intended plane', async () => {
    const store = await seededStore();
    await append(store, 2, {
      type: 'project.created',
      payload: { project_id: PROJECT, title: 'merchant onboarding' },
    });
    await append(store, 3, {
      type: 'direction.proposed',
      payload: {
        direction_id: uuidv7(),
        title: 'ship the intake form',
      },
    });

    const state = await getProjectState(store, PROJECT);

    expect(state.planes.intended.map((i) => i.anchor.event_type)).toEqual(['direction.proposed']);
    expect(state.planes.intended[0]?.label).toBe('ship the intake form');
  });

  it('answers an empty ledger with empty planes', async () => {
    const store = new InMemoryEventStore();

    const state = await getProjectState(store, PROJECT);

    expect(state.planes).toEqual({ history: [], current: [], intended: [] });
  });
});

describe('loadContext', () => {
  it('filters by type and paginates with a round-tripped cursor', async () => {
    const store = await seededStore();
    await append(store, 2, {
      type: 'work.created',
      payload: {
        work_id: uuidv7(),
        project_id: PROJECT,
        title: 'first',
        reason: 'step',
        actor: PARTICIPANT,
      },
    });
    await append(store, 3, {
      type: 'hold.registered',
      payload: {
        hold_id: uuidv7(),
        project_id: PROJECT,
        kind: 'tech_debt',
        severity: 'blocking',
        initial_status: 'active',
        blocks_delivery: true,
        statement: 'a hold',
        actor: PARTICIPANT,
        registered_by: PARTICIPANT,
      },
    });
    await append(store, 4, {
      type: 'work.created',
      payload: {
        work_id: uuidv7(),
        project_id: PROJECT,
        title: 'second',
        reason: 'step',
        actor: PARTICIPANT,
      },
    });

    const first = await loadContext(store, {
      project_id: PROJECT,
      filter: { types: ['work'] },
      cursor: undefined,
      limit: 1,
    });
    expect(first.entries.map((e) => e.seq)).toEqual([2]);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBeDefined();

    const second = await loadContext(store, {
      project_id: PROJECT,
      filter: { types: ['work'] },
      cursor: first.next_cursor,
      limit: 1,
    });
    // strictly after the first page's last seq — no overlap, no re-read
    expect(second.entries.map((e) => e.seq)).toEqual([4]);
    expect(second.has_more).toBe(false);
    expect(second.next_cursor).toBeUndefined();
  });

  it('admits events of any requested type in one request', async () => {
    const store = await seededStore();
    await append(store, 2, {
      type: 'work.created',
      payload: {
        work_id: uuidv7(),
        project_id: PROJECT,
        title: 'first',
        reason: 'step',
        actor: PARTICIPANT,
      },
    });
    await append(store, 3, {
      type: 'hold.registered',
      payload: {
        hold_id: uuidv7(),
        project_id: PROJECT,
        kind: 'tech_debt',
        severity: 'blocking',
        initial_status: 'active',
        blocks_delivery: true,
        statement: 'a hold',
        actor: PARTICIPANT,
        registered_by: PARTICIPANT,
      },
    });

    const both = await loadContext(store, {
      project_id: PROJECT,
      filter: { types: ['work', 'hold'] },
      cursor: undefined,
      limit: 10,
    });

    expect(both.entries.map((e) => e.event_type)).toEqual(['work.created', 'hold.registered']);
  });

  it('rejects a cursor that is not a seq payload rather than serving a wrong page', async () => {
    const store = await seededStore();
    // well-formed base64url, semantically invalid: no seq
    const bad = Buffer.from(JSON.stringify({ nope: 1 }), 'utf8')
      .toString('base64url')
      .replace(/=+$/u, '');

    await expect(
      loadContext(store, {
        project_id: PROJECT,
        filter: { types: ['work'] },
        cursor: bad,
        limit: 10,
      }),
    ).rejects.toThrow(/invalid context cursor/u);
  });

  it('labels an entry from its reason when it carries no title', async () => {
    const store = await seededStore();
    await append(store, 2, {
      type: 'work.status_changed',
      payload: {
        work_id: uuidv7(),
        from: 'active',
        to: 'paused',
        reason: 'waiting on the intake reply',
        actor: PARTICIPANT,
      },
    });

    const page = await loadContext(store, {
      project_id: PROJECT,
      filter: { types: ['work'] },
      cursor: undefined,
      limit: 10,
    });

    expect(page.entries[0]?.summary).toBe('waiting on the intake reply');
  });

  it('falls back to the event type when neither title nor reason is present', async () => {
    const store = await seededStore();
    await append(store, 2, {
      type: 'workrun.started',
      payload: {
        run_id: uuidv7(),
        work_id: uuidv7(),
        attempt: 1,
      },
    });

    const page = await loadContext(store, {
      project_id: PROJECT,
      filter: { types: ['work'] },
      cursor: undefined,
      limit: 10,
    });

    expect(page.entries[0]?.summary).toBe('workrun.started');
  });

  it('applies the time bounds', async () => {
    const store = await seededStore();
    await append(store, 2, {
      type: 'work.created',
      payload: {
        work_id: uuidv7(),
        project_id: PROJECT,
        title: 'first',
        reason: 'step',
        actor: PARTICIPANT,
      },
    });

    const before = await loadContext(store, {
      project_id: PROJECT,
      filter: { types: ['work'], from: '2026-09-02T00:00:00.000Z' },
      cursor: undefined,
      limit: 10,
    });
    expect(before.entries).toEqual([]);

    const at = await loadContext(store, {
      project_id: PROJECT,
      filter: { types: ['work'], to: '2026-09-02T00:00:00.000Z' },
      cursor: undefined,
      limit: 10,
    });
    expect(at.entries.map((e) => e.seq)).toEqual([2]);
  });
});

describe('searchProjects', () => {
  it('filters by membership and prefix server-side', async () => {
    const d = directory();

    const mine = await searchProjects(d, PARTICIPANT, {
      query: 'merchant',
      cursor: undefined,
      limit: 10,
    });
    expect(mine.results.map((r) => r.project_name)).toEqual(['merchant onboarding']);
    expect(mine.has_more).toBe(false);

    // a participant with no grants sees nothing, even on a matching prefix
    const other = await searchProjects(d, OTHER_PARTICIPANT, {
      query: 'merchant',
      cursor: undefined,
      limit: 10,
    });
    expect(other.results).toEqual([]);
  });

  it('paginates with the directory cursor and stops at the end', async () => {
    const d = directory();
    for (let i = 0; i < 3; i += 1) {
      const id = `01924a61-7a1b-7c2d-8e3f-${(100 + i).toString(16).padStart(12, '0')}`;
      d.register({
        project_id: id,
        title: `merchant ${String(i)}`,
        status: 'active',
        state_version: 0,
      });
      d.grant(PARTICIPANT, id);
    }

    const first = await searchProjects(d, PARTICIPANT, {
      query: 'merchant',
      cursor: undefined,
      limit: 2,
    });
    expect(first.results.length).toBe(2);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBeDefined();

    const second = await searchProjects(d, PARTICIPANT, {
      query: 'merchant',
      cursor: first.next_cursor,
      limit: 2,
    });
    expect(second.results.length).toBe(2);
    expect(second.has_more).toBe(false);
    expect(second.next_cursor).toBeUndefined();
  });

  it('rejects a project cursor that is not a (title, id) payload', async () => {
    const d = directory();
    const bad = Buffer.from(JSON.stringify({ nope: 1 }), 'utf8')
      .toString('base64url')
      .replace(/=+$/u, '');

    await expect(
      searchProjects(d, PARTICIPANT, { query: 'merchant', cursor: bad, limit: 10 }),
    ).rejects.toThrow(/invalid project cursor/u);
  });
});
