import { describe, expect, it } from 'vitest';

import {
  deepFreeze,
  canonicalJson,
  canonicalEquals,
  parseCanonicalJson,
} from '../src/state/canonical.js';
import { EventHistory, verifyEventHistory } from '../src/state/event-history.js';
import { stateEventSchema, type StateEvent } from '../src/state/events.js';

const at = '2026-09-02T00:00:00.000Z';

function evt(
  seq: number,
  type = 'hold_registered',
  extra: Record<string, unknown> = {},
): StateEvent {
  return stateEventSchema.parse({
    seq,
    type,
    data: { note: `e${String(seq)}` },
    actor: 'p-1',
    at,
    state_version: 0,
    schema_version: 1,
    ...extra,
  });
}

describe('canonical JSON', () => {
  it('sorts object keys recursively so equal structures serialize identically', () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const b = { a: { d: 2, c: [3, { e: 5, f: 4 }] }, b: 1 };
    expect(canonicalEquals(a, b)).toBe(true);
    expect(canonicalJson(a)).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it('round-trips through parseCanonicalJson and rejects non-finite numbers', () => {
    const value = { k: [1, 'x', { n: null }] };
    expect(canonicalEquals(parseCanonicalJson(canonicalJson(value)), value)).toBe(true);
    // exponent overflow parses to Infinity — the reviver, not the parser, must reject it
    expect(() => parseCanonicalJson('{"k": 1e999}')).toThrow(/non-finite/);
  });

  it('deepFreeze blocks nested writes and rejects cycles', () => {
    const value = { outer: { inner: [1, 2] } };
    deepFreeze(value);
    expect(() => {
      value.outer.inner[0] = 9;
    }).toThrow();
    expect(() => {
      (value.outer as { inner: unknown }).inner = 'x';
    }).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => deepFreeze(cyclic)).toThrow('cyclic');
    const shared = { value: 1 };
    const graph = deepFreeze({ first: shared, second: shared });
    expect(graph.first).toBe(graph.second);
    expect(() => {
      graph.second.value = 2;
    }).toThrow();
  });
});

describe('state event schema', () => {
  it('accepts the six semantic fields and rejects unknown ones', () => {
    expect(stateEventSchema.safeParse(evt(1)).success).toBe(true);
    const extra = evt(1) as Record<string, unknown>;
    extra[' rogue '] = 1;
    expect(stateEventSchema.safeParse({ ...evt(1), rogue: 1 }).success).toBe(false);
  });

  it('requires seq >= 1 and a non-empty type', () => {
    const base = { data: { note: 'x' }, actor: 'p-1', at, state_version: 0 };
    expect(stateEventSchema.safeParse({ ...base, seq: 0, type: 'hold_registered' }).success).toBe(
      false,
    );
    expect(stateEventSchema.safeParse({ ...base, seq: 1, type: '' }).success).toBe(false);
  });
});

describe('EventHistory', () => {
  it('appends with gapless monotonic seq: 1, 2, 3', () => {
    const h = new EventHistory();
    h.append(evt(1));
    h.append(evt(2));
    h.append(evt(3));
    expect(h.all().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(h.currentSeq).toBe(3);
  });

  it('rejects a seq that skips or repeats the head', () => {
    const h = new EventHistory();
    h.append(evt(1));
    expect(() => h.append(evt(3))).toThrow(/does not continue head/);
    expect(() => h.append(evt(1))).toThrow(/does not continue head/);
    expect(h.size).toBe(1); // all-or-nothing: rejected event not stored
  });

  it('deep-freezes on append: nested mutation attempts throw', () => {
    const h = new EventHistory();
    const stored = h.append(evt(1, 'hold_registered', { data: { nested: { v: 1 } } }));
    expect(() => {
      (stored.data as { nested: { v: number } }).nested.v = 2;
    }).toThrow();
    expect(() => {
      (stored as unknown as { type: string }).type = 'x';
    }).toThrow();
  });

  it('public collections cannot alter history and corrupt replay input is rejected', () => {
    const h = new EventHistory();
    h.append(evt(1));
    expect(h.verifyIntegrity().ok).toBe(true);
    expect(() => (h.all() as StateEvent[]).pop()).toThrow();
    expect(() => (h.load(1) as StateEvent[]).splice(0, 1)).toThrow();
    expect(Object.getOwnPropertyNames(h)).not.toContain('events');
    expect(h.currentSeq).toBe(1);
    const gap = verifyEventHistory([evt(1), evt(5)]);
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.atSeq).toBe(5);
    expect(verifyEventHistory([{ ...evt(1), type: '' }]).ok).toBe(false);
  });

  it('appending owns a copy without freezing caller data', () => {
    const h = new EventHistory();
    const input = evt(1, 'hold_registered', { data: { nested: { value: 1 } } });
    h.append(input);
    (input.data as { nested: { value: number } }).nested.value = 2;
    expect(h.head?.data).toEqual({ nested: { value: 1 } });
  });

  it('load(fromSeq) is cursor-inclusive and conservative on bad cursors', () => {
    const h = new EventHistory();
    [1, 2, 3].forEach((s) => h.append(evt(s)));
    expect(h.load(2).map((e) => e.seq)).toEqual([2, 3]);
    expect(h.load(0).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(h.load(9).map((e) => e.seq)).toEqual([]);
  });

  it('rejects events that fail the StateEvent schema before any mutation', () => {
    const h = new EventHistory();
    expect(() =>
      h.append({ ...evt(1), data: undefined as unknown as Record<string, unknown> }),
    ).toThrow(/invalid event/);
    expect(() => h.append({ ...evt(1), at: 12345 as unknown as string })).toThrow(/invalid event/);
    expect(h.size).toBe(0);
  });

  it('offers no update or delete path on the public surface', () => {
    const methods = Object.getOwnPropertyNames(EventHistory.prototype).filter(
      (m) => m !== 'constructor',
    );
    expect(methods.sort()).toEqual([
      'all',
      'append',
      'currentSeq',
      'head',
      'load',
      'size',
      'verifyIntegrity',
    ]);
    expect(methods.some((m) => /delete|update|remove|rewrite/i.test(m))).toBe(false);
  });
});
