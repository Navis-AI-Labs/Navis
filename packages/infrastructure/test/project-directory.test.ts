import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { InMemoryProjectDirectory } from '../src/persistence/in-memory/in-memory-project-directory.js';
import { PostgresProjectDirectory } from '../src/persistence/postgres/postgres-project-directory.js';

/**
 * The directory port's two halves: the fake-wire suite pins the SQL the
 * Postgres adapter issues (the join is the membership filter — the query
 * shape itself enforces deny-default), and the in-memory suite pins the
 * port semantics both adapters must share. A real DATABASE_URL integration
 * run covers the same paths on a live wire.
 */

const PARTICIPANT = '01924a61-7a1b-7c2d-8e3f-0000000000b1';
const OTHER_PARTICIPANT = '01924a61-7a1b-7c2d-8e3f-0000000000b2';
const PROJECT_A = '01924a61-7a1b-7c2d-8e3f-000000000001';
const PROJECT_B = '01924a61-7a1b-7c2d-8e3f-000000000002';

function summary(projectId: string, title: string, stateVersion = 0) {
  return {
    project_id: projectId,
    title,
    status: 'active',
    state_version: stateVersion,
  };
}

/** The three projections a directory page serves, as the adapter maps them. */
function row(id: string, title: string, version = 0) {
  return { id, title, status: 'active', current_state_version: version };
}

describe('InMemoryProjectDirectory', () => {
  it('lists only granted projects matching the prefix', async () => {
    const d = new InMemoryProjectDirectory();
    d.register(summary(PROJECT_A, 'merchant onboarding'));
    d.register(summary(PROJECT_B, 'private ledger'));
    d.grant(PARTICIPANT, PROJECT_A);

    await expect(d.search(PARTICIPANT, 'merchant', 10, null)).resolves.toEqual({
      results: [summary(PROJECT_A, 'merchant onboarding')],
      has_more: false,
      next_cursor: null,
    });
  });

  it('hides projects the participant is not a member of', async () => {
    const d = new InMemoryProjectDirectory();
    d.register(summary(PROJECT_A, 'merchant onboarding'));
    d.register(summary(PROJECT_B, 'private ledger'));
    d.grant(PARTICIPANT, PROJECT_A);

    await expect(d.search(PARTICIPANT, 'private', 10, null)).resolves.toHaveProperty('results', []);
  });

  it('paginates with an exclusive cursor and no overlap', async () => {
    const d = new InMemoryProjectDirectory();
    d.register(summary(PROJECT_A, 'merchant a'));
    d.register(summary(PROJECT_B, 'merchant b'));
    d.grant(PARTICIPANT, PROJECT_A);
    d.grant(PARTICIPANT, PROJECT_B);

    const first = await d.search(PARTICIPANT, 'merchant', 1, null);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).not.toBeNull();

    const second = await d.search(PARTICIPANT, 'merchant', 1, first.next_cursor);
    expect(second.results.map((r) => r.project_id)).toEqual([PROJECT_B]);
    expect(second.has_more).toBe(false);
  });

  it('answers the membership gate for granted and denied participants', async () => {
    const d = new InMemoryProjectDirectory();
    d.register(summary(PROJECT_A, 'merchant onboarding'));
    d.grant(PARTICIPANT, PROJECT_A);

    await expect(d.isMember(PARTICIPANT, PROJECT_A)).resolves.toBe(true);
    await expect(d.isMember(OTHER_PARTICIPANT, PROJECT_A)).resolves.toBe(false);
    await expect(d.isMember(PARTICIPANT, PROJECT_B)).resolves.toBe(false);
  });
});

describe('PostgresProjectDirectory', () => {
  it('issues a membership-joined prefix query', async () => {
    const recorded: string[] = [];
    const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      recorded.push(strings.join(' ? '));
      void values;
      return Promise.resolve([row(PROJECT_A, 'merchant onboarding')]);
    };
    const sql = tag as unknown as postgres.Sql;
    const d = new PostgresProjectDirectory(sql);

    const page = await d.search(PARTICIPANT, 'merchant', 10, null);

    // the join is the filter: no client-side membership anywhere
    const text = recorded.join('\n');
    expect(text).toContain('JOIN project_members');
    expect(text).toContain('AND m.participant_id =');
    // limit+1 parameter: one row past the page detects the next page
    expect(text).toContain('LIMIT');
    expect(page.results).toEqual([summary(PROJECT_A, 'merchant onboarding')]);
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
  });

  it('reads the next page strictly after the cursor', async () => {
    let call = 0;
    const pages = [
      [row(PROJECT_A, 'merchant a'), row(PROJECT_B, 'merchant b')],
      [row(PROJECT_B, 'merchant b')],
    ];
    const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      void values;
      const text = strings.join(' ? ');
      // only the real directory query advances the page; the nested cursor
      // branch (empty or not) is a parameter, not a separate result set
      if (!text.includes('SELECT p.id')) return Promise.resolve([]);
      const rows = pages[call] ?? [];
      call += 1;
      return Promise.resolve(rows);
    };
    const sql = tag as unknown as postgres.Sql;
    const d = new PostgresProjectDirectory(sql);

    const first = await d.search(PARTICIPANT, 'merchant', 1, null);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual({ title: 'merchant a', project_id: PROJECT_A });

    const second = await d.search(PARTICIPANT, 'merchant', 1, first.next_cursor);
    expect(second.results.map((r) => r.project_id)).toEqual([PROJECT_B]);
    expect(second.has_more).toBe(false);
  });

  it('answers the membership gate from the members table', async () => {
    const recorded: string[] = [];
    const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      recorded.push(strings.join(' ? '));
      void values;
      return Promise.resolve([{}]);
    };
    const sql = tag as unknown as postgres.Sql;
    const d = new PostgresProjectDirectory(sql);

    await expect(d.isMember(PARTICIPANT, PROJECT_A)).resolves.toBe(true);
    expect(recorded[0]).toContain('FROM project_members');
  });

  it('denies when no membership row exists', async () => {
    const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      void strings;
      void values;
      return Promise.resolve([]);
    };
    const sql = tag as unknown as postgres.Sql;
    const d = new PostgresProjectDirectory(sql);

    await expect(d.isMember(OTHER_PARTICIPANT, PROJECT_A)).resolves.toBe(false);
  });
});
