import { describe, expect, it } from 'vitest';

import { createUuidv7, uuidv7, uuidv7Schema, uuidv7Timestamp } from '../src/schema/ids.js';

describe('UUIDv7 identifiers', () => {
  it('generates valid UUIDv7 strings', () => {
    const id = uuidv7();
    expect(uuidv7Schema.safeParse(id).success).toBe(true);
  });

  it('is lexicographically ordered by creation time', () => {
    const a = uuidv7();
    const b = uuidv7();
    const c = uuidv7();
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it('stays monotonic within the same millisecond', () => {
    // Fixed clock: all 50 ids generated in the same ms
    const tick = 1_700_000_000_000;
    const clock = () => tick; // constant timestamp
    const gen = createUuidv7(clock);
    const ids = Array.from({ length: 50 }, () => gen());
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1];
      const curr = ids[i];
      if (prev === undefined || curr === undefined) throw new Error('unreachable');
      expect(prev < curr).toBe(true);
    }
  });

  it('stays monotonic when the clock ticks backwards (same-ms fallback)', () => {
    // clock goes back: fall back to the last-seen timestamp, keep the counter increasing
    let tick = 1_700_000_000_100;
    const ids: string[] = [];
    const clock = () => {
      tick -= 50; // backwards
      return tick;
    };
    const gen = createUuidv7(clock);
    for (let i = 0; i < 10; i++) ids.push(gen());
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1];
      const curr = ids[i];
      if (prev === undefined || curr === undefined) throw new Error('unreachable');
      expect(prev < curr).toBe(true);
    }
  });

  it('increments the millisecond correctly when the clock advances', () => {
    let tick = 1_700_000_000_000;
    const clock = () => ++tick;
    const gen = createUuidv7(clock);
    const ids = Array.from({ length: 5 }, () => gen());
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1];
      const curr = ids[i];
      if (prev === undefined || curr === undefined) throw new Error('unreachable');
      expect(prev < curr).toBe(true);
    }
  });

  it('borrows a millisecond when the 12-bit counter overflows (4096 ids in one ms)', () => {
    const tick = 1_700_000_000_000;
    const gen = createUuidv7(() => tick);
    const ids = Array.from({ length: 4100 }, () => gen());
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1];
      const curr = ids[i];
      if (prev === undefined || curr === undefined) throw new Error('unreachable');
      expect(prev < curr).toBe(true);
    }
    // counter starts anywhere in [0,4095]; the last id lands in the borrowed next ms
    const first = ids[0];
    const last = ids[4099];
    if (first === undefined || last === undefined) throw new Error('unreachable');
    expect(uuidv7Timestamp(first)).toBe(tick);
    expect(uuidv7Timestamp(last)).toBe(tick + 1);
  });

  it('rejects non-v7 UUIDs in the strict schema', () => {
    const v4 = '550e8400-e29b-41d4-a716-446655440000';
    expect(uuidv7Schema.safeParse(v4).success).toBe(false);
    expect(uuidv7Schema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('recovers the embedded timestamp', () => {
    const ts = 1_700_000_123_456;
    const id = createUuidv7(() => ts)();
    expect(uuidv7Timestamp(id)).toBe(ts);
  });

  it('returns null for non-v7 or malformed inputs', () => {
    expect(uuidv7Timestamp('550e8400-e29b-41d4-a716-446655440000')).toBeNull(); // v4
    expect(uuidv7Timestamp('garbage')).toBeNull();
  });

  it('enforces the RFC 9562 variant bits (10xx), not just the version nibble', () => {
    // v7 version nibble but NCS variant (variant nibble < 8): must be rejected.
    expect(uuidv7Schema.safeParse('018f3c1e-1f7b-7def-1f2f-6c9a1d2e3f40').success).toBe(false);
    // v7 version nibble and RFC variant ('b' = 1011): must be accepted.
    expect(uuidv7Schema.safeParse('018f3c1e-1f7b-7def-bf2f-6c9a1d2e3f40').success).toBe(true);
  });
});
