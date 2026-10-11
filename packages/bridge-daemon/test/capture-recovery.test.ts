import { mkdtempSync, rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import { uuidv7 } from '@navis/domain';
import { openDaemonDb } from '../src/persistence/sqlite-binding.js';
import { SqliteOutbox } from '../src/outbox/sqlite-outbox.js';
import { tick } from '../src/outbox/upload-loop.js';
const AT = '2026-10-10T00:00:00.000Z';
it('keeps capture identities, causal heads and sequence allocation after acknowledgment and restart', async () => {
  const dir = mkdtempSync('/tmp/nr-');
  const file = `${dir}/bridge.sqlite`;
  let db = openDaemonDb(file);
  let store = new SqliteOutbox(db, () => AT);
  const device = uuidv7();
  const project = uuidv7();
  const input = (id: string) => ({
    event_id: id,
    device_id: device,
    project_id: project,
    event_type: 'user.message',
    event_json: '{}',
    privacy_class: 'metadata' as const,
  });
  try {
    const first = uuidv7();
    expect(await store.captureOnce(input(first), 'hash-one', 'session')).toEqual({
      duplicate: false,
    });
    expect(await store.captureOnce(input(first), 'hash-one', 'session')).toEqual({
      duplicate: true,
    });
    await expect(store.captureOnce(input(first), 'changed', 'session')).rejects.toThrow(
      'conflicts',
    );
    await store.promoteToPending(first, 'binding');
    await store.claimPending(device, 1, AT);
    await store.acknowledge([first]);
    expect(await store.captureOnce(input(first), 'hash-one', 'session')).toEqual({
      duplicate: true,
    });
    expect(await store.get(first)).toBeNull();
    db.close();
    db = openDaemonDb(file);
    store = new SqliteOutbox(db, () => AT);
    const second = uuidv7();
    await store.captureOnce(input(second), 'hash-two', 'session');
    const pending = await store.promoteToPending(second, 'binding');
    expect(pending.seq).toBe(2);
    expect(pending.causation_id).toBe(first);
    await store.claimPending(device, 1, AT);
    expect((await store.promoteToPending(second, 'binding')).seq).toBe(2);
    const slice = await tick(
      store,
      {
        send: () =>
          Promise.resolve({ status: 429, body: '', retryAfter: '2026-10-10T00:01:00.000Z' }),
      },
      device,
      AT,
    );
    expect(slice.nextTickAt).toBe('2026-10-10T00:01:00.000Z');
    expect(await store.claimPending(device, 1, '2026-10-10T00:00:59.000Z')).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
