import { describe, expect, it } from 'vitest';

import { extractSessionEvents, type RawSessionStep } from '../src/session/extract.js';

/**
 * Spec scenarios: (1) a metadata-class session transmits no content — the
 * payload holds hash/length/bounded summary only, and body/parameters/
 * results are absent; (2) session order is recoverable from causation —
 * each event's causation_id points at its predecessor.
 */

const OPTIONS = {
  deviceId: '01924a61-7a1b-7c2d-8e3f-0000000000a1',
  projectId: '01924a61-7a1b-7c2d-8e3f-000000000001',
};

describe('session event extraction', () => {
  it('a metadata-class session transmits hashes and lengths, never content', () => {
    const steps: RawSessionStep[] = [
      { kind: 'user.message', body: 'please delete the production database' },
      { kind: 'tool.call.requested', tool: 'bash', parameters: { command: 'rm -rf /' } },
      { kind: 'tool.call.result', tool: 'bash', result: { stdout: 'everything gone' } },
    ];

    const events = extractSessionEvents(steps, { ...OPTIONS, privacyClass: 'metadata' });
    expect(events.length).toBe(3);

    for (const ev of events) {
      const payload = JSON.parse(ev.event_json) as {
        data: Record<string, unknown>;
      };
      expect(typeof payload.data['sha256']).toBe('string');
      expect(typeof payload.data['length']).toBe('number');
      expect(typeof payload.data['summary']).toBe('string');
      // content fields must be absent, not redacted-null — nothing to leak
      expect(ev.event_json).not.toContain('production database');
      expect(ev.event_json).not.toContain('"command"');
      expect(ev.event_json).not.toContain('everything gone');
      expect(ev.event_json).not.toContain('body');
      expect(ev.event_json).not.toContain('"parameters"');
      expect(ev.event_json).not.toContain('"result"');
    }
  });

  it('tool events keep the tool name in metadata but drop parameters/results', () => {
    const steps: RawSessionStep[] = [
      { kind: 'tool.call.requested', tool: 'fs.write', parameters: { path: '/etc/passwd' } },
      { kind: 'tool.call.result', tool: 'fs.write', result: 'wrote 42 bytes' },
    ];
    const events = extractSessionEvents(steps, { ...OPTIONS, privacyClass: 'metadata' });
    const requested = JSON.parse(events[0]?.event_json ?? '') as { data: Record<string, unknown> };
    const result = JSON.parse(events[1]?.event_json ?? '') as { data: Record<string, unknown> };
    expect(requested.data['tool']).toBe('fs.write');
    expect(result.data['tool']).toBe('fs.write');
    expect(events[0]?.event_json).not.toContain('/etc/passwd');
    expect(events[1]?.event_json).not.toContain('wrote 42 bytes');
  });

  it('summaries are bounded at 120 chars and flatten newlines', () => {
    const longBody = `${'x'.repeat(200)}\nwith-newline`;
    const steps: RawSessionStep[] = [{ kind: 'user.message', body: longBody }];
    const [ev] = extractSessionEvents(steps, { ...OPTIONS, privacyClass: 'metadata' });
    const payload = JSON.parse(ev?.event_json ?? '') as {
      data: { summary: string; length: number };
    };
    expect(payload.data.summary.length).toBeLessThanOrEqual(121);
    expect(payload.data.summary).not.toContain('\n');
    expect(payload.data.length).toBe(longBody.length);
  });

  it('causation links each event to its predecessor so replay recovers order', () => {
    const ids = ['e1', 'e2', 'e3'].map((x) => `01924a61-7a1b-7c2d-8e3f-${x.padEnd(12, '0')}`);
    let counter = 0;
    const newEventId = () => ids[counter++] ?? 'overflow-id';

    const steps: RawSessionStep[] = [
      { kind: 'user.message', body: 'one' },
      { kind: 'agent.message', body: 'two' },
      { kind: 'tool.call.result', tool: 't', result: 'three' },
    ];
    const events = extractSessionEvents(steps, {
      ...OPTIONS,
      privacyClass: 'metadata',
      newEventId,
    });

    expect(events[0]?.causation_id).toBeUndefined();
    expect(events[1]?.causation_id).toBe(events[0]?.event_id);
    expect(events[2]?.causation_id).toBe(events[1]?.event_id);

    // replay: following causation backwards from the tip reconstructs order
    const byId = new Map(events.map((e) => [e.event_id, e]));
    const replayed: string[] = [];
    let cursor = events[events.length - 1];
    while (cursor !== undefined) {
      replayed.unshift(cursor.event_type);
      cursor = cursor.causation_id !== undefined ? byId.get(cursor.causation_id) : undefined;
    }
    expect(replayed).toEqual(['user.message', 'agent.message', 'tool.call.result']);
  });

  it('a local-only session takes the same protected shape and is marked for parking', () => {
    const [ev] = extractSessionEvents([{ kind: 'agent.message', body: 'internal note' }], {
      ...OPTIONS,
      privacyClass: 'local-only',
    });
    expect(ev?.privacy_class).toBe('local-only');
    // extraction shape is identical; the outbox parks it (null seq forever)
    expect(JSON.parse(ev?.event_json ?? '')).toHaveProperty('data.sha256');
  });

  it('handles an empty step list without emitting a spurious root', () => {
    const events = extractSessionEvents([], { ...OPTIONS, privacyClass: 'metadata' });
    expect(events).toEqual([]);
  });
});
