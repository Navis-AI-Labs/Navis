import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { probeConnection } from '../src/persistence/postgres/connection.js';
describe('bounded database readiness', () => {
  it('accepts a completed query and propagates a driver failure', async () => {
    const cancel = vi.fn();
    const sql = (() => Object.assign(Promise.resolve([]), { cancel })) as unknown as postgres.Sql;
    await expect(probeConnection(sql)).resolves.toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
    const failed = (() =>
      Object.assign(Promise.reject(new Error('unreachable')), {
        cancel,
      })) as unknown as postgres.Sql;
    await expect(probeConnection(failed)).rejects.toThrow('unreachable');
  });
  it('cancels a query that cannot meet the readiness deadline', async () => {
    const cancel = vi.fn();
    const sql = (() =>
      Object.assign(new Promise(() => undefined), { cancel })) as unknown as postgres.Sql;
    await expect(probeConnection(sql, 5)).rejects.toThrow('deadline');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
