import { describe, expect, it } from 'vitest';

import {
  advanceClock,
  compareClocks,
  mergeClocks,
  type ClockSnapshot,
} from '../src/state/vector-clock.js';

// Deterministic generator over snapshot pairs: exercises the comparison
// across shapes the fixed examples would miss (disjoint keys, zeros absent
// vs explicit, equal components, single-sided growth).
const snapshotPairs: [ClockSnapshot, ClockSnapshot][] = [
  [{}, {}],
  [{ a: 1 }, {}],
  [{}, { a: 1 }],
  [{ a: 1 }, { a: 1 }],
  [{ a: 3 }, { a: 1 }],
  [{ a: 1 }, { a: 3 }],
  [
    { a: 2, b: 1 },
    { a: 1, b: 3 },
  ],
  [{ a: 2 }, { b: 2 }],
  [{ a: 2, b: 0 }, { a: 2 }],
  [
    { a: 1, b: 1, c: 5 },
    { a: 1, b: 1, c: 5, d: 1 },
  ],
];

describe('four-verdict comparison', () => {
  it.each(snapshotPairs)('mirror-consistency for %j vs %j', (a, b) => {
    const forward = compareClocks(a, b);
    const backward = compareClocks(b, a);
    if (forward === 'equal') expect(backward).toBe('equal');
    else if (forward === 'dominates') expect(backward).toBe('dominated_by');
    else if (forward === 'dominated_by') expect(backward).toBe('dominates');
    else expect(backward).toBe('concurrent');
  });

  it.each(snapshotPairs)('self-comparison is equal for %j', (a) => {
    expect(compareClocks(a, a)).toBe('equal');
  });

  it('detects parallel observations on either side of disjoint growth', () => {
    expect(compareClocks({ a: 2, b: 1 }, { a: 1, b: 3 })).toBe('concurrent');
    expect(compareClocks({ a: 2 }, { b: 2 })).toBe('concurrent');
  });

  it('detects ordered knowledge in both directions', () => {
    expect(compareClocks({ a: 3, b: 1 }, { a: 1, b: 1 })).toBe('dominates');
    expect(compareClocks({ a: 1, b: 1 }, { a: 3, b: 1 })).toBe('dominated_by');
  });

  it('treats absent components as zero', () => {
    expect(compareClocks({ a: 2 }, { a: 2, b: 0 })).toBe('equal');
    expect(compareClocks({}, { a: 1 })).toBe('dominated_by');
  });
});

describe('merge', () => {
  it('keeps the component-wise maximum', () => {
    expect(mergeClocks({ a: 2, b: 1 }, { a: 1, b: 3, c: 1 })).toEqual({ a: 2, b: 3, c: 1 });
  });

  it('never regresses any component', () => {
    for (const [a, b] of snapshotPairs) {
      const merged = mergeClocks(a, b);
      const vsA = compareClocks(merged, a);
      const vsB = compareClocks(merged, b);
      expect(vsA === 'dominates' || vsA === 'equal').toBe(true);
      expect(vsB === 'dominates' || vsB === 'equal').toBe(true);
    }
  });

  it('is idempotent', () => {
    const merged = mergeClocks({ a: 2, b: 1 }, { a: 1, b: 3 });
    expect(mergeClocks(merged, merged)).toEqual(merged);
  });
});

describe('advance', () => {
  it('advances exactly the author component by exactly 1', () => {
    expect(advanceClock({ a: 2, b: 5 }, 'a')).toEqual({ a: 3, b: 5 });
    expect(advanceClock({}, 'a')).toEqual({ a: 1 });
  });

  it('grows the clock monotonically through repeated advances', () => {
    let clock: ClockSnapshot = {};
    for (let i = 0; i < 5; i++) clock = advanceClock(clock, 'a');
    for (let i = 0; i < 3; i++) clock = advanceClock(clock, 'b');
    expect(clock).toEqual({ a: 5, b: 3 });
    expect(compareClocks(clock, { a: 5, b: 3 })).toBe('equal');
  });
});
