import { describe, expect, it } from 'vitest';

import { createPostgresCommandIntake } from '../src/persistence/postgres/postgres-command-intake-tx.js';

/**
 * Fake-wire unit suite: a scripted postgres.js stand-in captures the
 * transaction lifecycle (begin → statements → commit-or-rollback), so the
 * compositional guarantee is pinned without a database. The live-PG
 * behaviors are pinned by the shared contract suite running against the
 * PostgresCommandInbox inside its existing transactions.
 */

const PROJECT = '01923b10-0000-7000-8000-000000000001';

function fakeBegin() {
  const events: string[] = [];
  const tx = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    void values;
    const text = strings.join(' ? ');
    if (text.includes('INSERT INTO command_inbox')) {
      events.push('insert');
      return Promise.resolve([{ status: 'received' }]);
    }
    if (text.includes('UPDATE command_inbox')) {
      events.push('update');
      return Promise.resolve([{ status: 'applied' }]);
    }
    throw new Error(`unscripted query: ${text}`);
  };
  const sql = {
    async begin<A>(fn: (t: unknown) => Promise<A>): Promise<A> {
      events.push('begin');
      const result = await fn(tx);
      events.push('commit');
      return result;
    },
    events,
  };
  return sql;
}

describe('createPostgresCommandIntake (fake-wire)', () => {
  it('runs begin, execute, complete inside one transaction, then commits', async () => {
    const sql = fakeBegin();
    const intake = createPostgresCommandIntake(sql as never);
    const out = await intake.dispatch(
      { projectId: PROJECT, idempotencyKey: 'k', commandType: 'op', payload: { a: 1 } },
      (_tx, payload) => Promise.resolve({ ok: true as const, value: payload }),
    );
    expect(out.status).toBe('applied');
    expect(out).toMatchObject({ status: 'applied', replayed: false });
    expect(sql.events).toEqual(['begin', 'insert', 'update', 'commit']);
  });

  it('an executor failure exits before commit bookkeeping and the error is visible', async () => {
    const sql = fakeBegin();
    const intake = createPostgresCommandIntake(sql as never);
    await expect(
      intake.dispatch(
        { projectId: PROJECT, idempotencyKey: 'k2', commandType: 'op', payload: {} },
        () => Promise.reject(new Error('executor exploded')),
      ),
    ).rejects.toThrow('executor exploded');
    expect(sql.events).toEqual(['begin', 'insert']);
  });

  it('the executor receives the transaction handle, not the outer connection', async () => {
    const captured: unknown[] = [];
    const sql = fakeBegin();
    const intake = createPostgresCommandIntake(sql as never);
    await intake.dispatch(
      { projectId: PROJECT, idempotencyKey: 'k3', commandType: 'op', payload: null },
      (tx, payload) => {
        captured.push(tx);
        expect(payload).toBeNull();
        return Promise.resolve({ ok: true as const, value: null });
      },
    );
    expect(captured).toHaveLength(1);
    expect(typeof captured[0]).toBe('function');
    expect(captured[0]).not.toBe(sql);
  });
});
