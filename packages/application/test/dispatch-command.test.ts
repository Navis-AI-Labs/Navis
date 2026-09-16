import { describe, expect, it, vi } from 'vitest';

import { InMemoryCommandInbox } from '@navis/infrastructure';

import { dispatchCommand, type DispatchRequest } from '../src/index.js';

const projectId = '01923b10-0000-7000-8000-000000000009';

function request(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    projectId,
    idempotencyKey: 'cmd-1',
    commandType: 'create_project',
    payload: { title: 'demo' },
    ...overrides,
  };
}

describe('dispatchCommand idempotency', () => {
  it('executes once and replays the identical resubmission without re-invoking', async () => {
    const inbox = new InMemoryCommandInbox();
    const execute = vi.fn(() => Promise.resolve({ ok: true as const, value: { id: 'p-1' } }));
    const first = await dispatchCommand(inbox, request(), execute);
    expect(first).toEqual({
      status: 'applied',
      result: { ok: true, value: { id: 'p-1' } },
      replayed: false,
    });
    const again = await dispatchCommand(inbox, request(), execute);
    expect(again).toEqual({
      status: 'applied',
      result: { ok: true, value: { id: 'p-1' } },
      replayed: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejection replays identically as failed without re-invoking the executor', async () => {
    const inbox = new InMemoryCommandInbox();
    const execute = vi.fn(() =>
      Promise.resolve({ ok: false as const, error: { code: 'not-now' } }),
    );
    const first = await dispatchCommand(inbox, request(), execute);
    expect(first.status).toBe('failed');
    if (first.status === 'in_flight') throw new Error('unexpected in-flight first attempt');
    expect(first.replayed).toBe(false);
    const again = await dispatchCommand(inbox, request(), execute);
    if (again.status === 'in_flight') throw new Error('unexpected in-flight replay');
    expect({ ...again, replayed: false }).toEqual({ ...first, replayed: false });
    expect(again.replayed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('an executor exception leaves the claim wedged: resubmission sees in_flight, never a re-run', async () => {
    const inbox = new InMemoryCommandInbox();
    const execute = vi.fn(() => Promise.reject(new Error('boom')));
    await expect(dispatchCommand(inbox, request(), execute)).rejects.toThrow('boom');
    const second = await dispatchCommand(inbox, request(), execute);
    expect(second).toEqual({ status: 'in_flight' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a missing idempotency key refuses before any claim or execution', async () => {
    const inbox = new InMemoryCommandInbox();
    const execute = vi.fn(() => Promise.resolve({ ok: true as const, value: null }));
    await expect(dispatchCommand(inbox, request({ idempotencyKey: '' }), execute)).rejects.toThrow(
      /idempotency-key-required/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('same key with a changed payload refuses instead of replaying', async () => {
    const inbox = new InMemoryCommandInbox();
    const execute = vi.fn(() => Promise.resolve({ ok: true as const, value: null }));
    await dispatchCommand(inbox, request(), execute);
    await expect(
      dispatchCommand(inbox, request({ payload: { title: 'other' } }), execute),
    ).rejects.toThrow(/collides-with-different-payload/);
  });

  it('a payload with reordered keys is the same submission', async () => {
    const inbox = new InMemoryCommandInbox();
    const execute = vi.fn(() => Promise.resolve({ ok: true as const, value: null }));
    await dispatchCommand(inbox, request(), execute);
    // Same content, different key order — canonical hash must equalize.
    const reordered = request({ payload: JSON.parse('{"title":"demo"}') as unknown });
    const again = await dispatchCommand(inbox, reordered, execute);
    if (again.status === 'in_flight') throw new Error('unexpected in-flight reordered replay');
    expect(again.replayed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('oversized outcome is terminal-failed with a bounded marker and throws loudly', async () => {
    const inbox = new InMemoryCommandInbox();
    const execute = vi.fn(() => Promise.resolve({ ok: true as const, value: 'x'.repeat(70_000) }));
    await expect(dispatchCommand(inbox, request(), execute)).rejects.toThrow(
      /exceeds-intake-budget/,
    );
    const again = await dispatchCommand(inbox, request(), execute);
    expect(again.status).toBe('failed');
    if (again.status === 'in_flight') throw new Error('unexpected in-flight oversized replay');
    expect(again.replayed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
