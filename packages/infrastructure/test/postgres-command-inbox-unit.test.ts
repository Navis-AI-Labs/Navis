import { describe, expect, it } from 'vitest';

import type { BeginResult } from '@navis/domain';

import { PostgresCommandInbox } from '../src/persistence/postgres/postgres-command-inbox.js';

/**
 * Fake-wire unit suite for PostgresCommandInbox: a scripted postgres.js
 * stand-in records every statement and replays canned rows, so every
 * decision branch of the adapter is pinned deterministically without a
 * database. The real-PG contract run (DATABASE_URL set) proves the same
 * behavior on the wire.
 */

interface RecordedQuery {
  text: string;
  params: unknown[];
}

interface CannedAnswers {
  /** rows returned by the claim INSERT (empty array = the loser path) */
  insertRows?: unknown[];
  /** rows returned by the classification SELECT */
  selectRows?: unknown[];
  /** rows returned by the completion UPDATE */
  updateRows?: unknown[];
  /** rows returned by the post-update SELECT */
  statusRows?: unknown[];
}

function makeFakeSql(answers: CannedAnswers) {
  const queries: RecordedQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join(' ? ');
    queries.push({ text, params: values });
    if (text.includes('INSERT INTO command_inbox'))
      return Promise.resolve(answers.insertRows ?? []);
    if (text.includes('UPDATE command_inbox')) return Promise.resolve(answers.updateRows ?? []);
    if (text.includes('SELECT status FROM command_inbox'))
      return Promise.resolve(answers.statusRows ?? []);
    if (text.includes('FROM command_inbox')) return Promise.resolve(answers.selectRows ?? []);
    throw new Error(`unscripted query: ${text}`);
  };
  return { tag, queries };
}

const PROJECT = '01923b10-0000-7000-8000-000000000001';
const HASH = 'sha256:' + 'ab'.repeat(32);

describe('PostgresCommandInbox fake-wire', () => {
  it('inserting a new claim returns fresh', async () => {
    const { tag } = makeFakeSql({ insertRows: [{ status: 'received' }] });
    const inbox = new PostgresCommandInbox(tag as unknown as never);
    const verdict = await inbox.begin(PROJECT, 'k', 'create_project', HASH);
    expect(verdict).toEqual({ status: 'fresh' } satisfies BeginResult);
  });

  it('losing the INSERT race with identical payload reports processing while received', async () => {
    const { tag } = makeFakeSql({
      insertRows: [],
      selectRows: [
        {
          command_type: 'create_project',
          payload_hash: HASH,
          status: 'received',
          result_ref: null,
        },
      ],
    });
    const inbox = new PostgresCommandInbox(tag as unknown as never);
    const verdict = await inbox.begin(PROJECT, 'k', 'create_project', HASH);
    expect(verdict).toEqual({ status: 'processing' } satisfies BeginResult);
  });

  it('losing the INSERT race after completion replays the stored outcome', async () => {
    const { tag } = makeFakeSql({
      insertRows: [],
      selectRows: [
        {
          command_type: 'create_project',
          payload_hash: HASH,
          status: 'applied',
          result_ref: '{"ok":true,"value":7}',
        },
      ],
    });
    const inbox = new PostgresCommandInbox(tag as unknown as never);
    const verdict = await inbox.begin(PROJECT, 'k', 'create_project', HASH);
    expect(verdict).toEqual({
      status: 'replay',
      outcome: { status: 'applied', result: '{"ok":true,"value":7}' },
    } satisfies BeginResult);
  });

  it('losing the INSERT race on a failed claim replays the failed outcome', async () => {
    const { tag } = makeFakeSql({
      insertRows: [],
      selectRows: [
        {
          command_type: 'create_project',
          payload_hash: HASH,
          status: 'failed',
          result_ref: '{"ok":false,"error":"nope"}',
        },
      ],
    });
    const inbox = new PostgresCommandInbox(tag as unknown as never);
    const verdict = await inbox.begin(PROJECT, 'k', 'create_project', HASH);
    expect(verdict).toEqual({
      status: 'replay',
      outcome: { status: 'failed', result: '{"ok":false,"error":"nope"}' },
    } satisfies BeginResult);
  });

  it('same key with a different payload hash refuses as a collision', async () => {
    const { tag } = makeFakeSql({
      insertRows: [],
      selectRows: [
        {
          command_type: 'create_project',
          payload_hash: HASH,
          status: 'received',
          result_ref: null,
        },
      ],
    });
    const inbox = new PostgresCommandInbox(tag as unknown as never);
    await expect(inbox.begin(PROJECT, 'k', 'create_project', 'sha256:other')).rejects.toThrow(
      /collides-with-different-payload/,
    );
  });

  it('same hash but a different command type refuses as a collision', async () => {
    const { tag } = makeFakeSql({
      insertRows: [],
      selectRows: [
        {
          command_type: 'rename_project',
          payload_hash: HASH,
          status: 'received',
          result_ref: null,
        },
      ],
    });
    const inbox = new PostgresCommandInbox(tag as unknown as never);
    await expect(inbox.begin(PROJECT, 'k', 'create_project', HASH)).rejects.toThrow(
      /collides-with-different-payload/,
    );
  });

  it('a terminal claim without a stored outcome is a loud storage violation', async () => {
    const { tag } = makeFakeSql({
      insertRows: [],
      selectRows: [
        { command_type: 'create_project', payload_hash: HASH, status: 'applied', result_ref: null },
      ],
    });
    const inbox = new PostgresCommandInbox(tag as unknown as never);
    await expect(inbox.begin(PROJECT, 'k', 'create_project', HASH)).rejects.toThrow(
      /terminal claim without a stored outcome/,
    );
  });

  it('a row that vanishes between conflict and read refuses loudly', async () => {
    const { tag } = makeFakeSql({ insertRows: [], selectRows: [] });
    const inbox = new PostgresCommandInbox(tag as unknown as never);
    await expect(inbox.begin(PROJECT, 'k', 'create_project', HASH)).rejects.toThrow(/vanished/);
  });

  it('complete transitions a received claim to its terminal outcome', async () => {
    const { tag, queries } = makeFakeSql({ updateRows: [{ status: 'applied' }] });
    const inbox = new PostgresCommandInbox(tag as unknown as never);
    await inbox.complete(PROJECT, 'k', { status: 'applied', result: '{"ok":true,"value":1}' });
    expect(queries.some((q) => q.text.includes('UPDATE command_inbox'))).toBe(true);
    expect(queries[0]?.params).toEqual(['applied', '{"ok":true,"value":1}', PROJECT, 'k']);
  });

  it('complete on an unknown key refuses loudly', async () => {
    const { tag } = makeFakeSql({ updateRows: [], statusRows: [] });
    const inbox = new PostgresCommandInbox(tag as unknown as never);
    await expect(inbox.complete(PROJECT, 'k', { status: 'failed', result: '{}' })).rejects.toThrow(
      /has-no-claim/,
    );
  });

  it('re-completing a terminal claim refuses as a collision', async () => {
    const { tag } = makeFakeSql({ updateRows: [], statusRows: [{ status: 'applied' }] });
    const inbox = new PostgresCommandInbox(tag as unknown as never);
    await expect(inbox.complete(PROJECT, 'k', { status: 'failed', result: '{}' })).rejects.toThrow(
      /collides-with-different-payload/,
    );
  });
});
