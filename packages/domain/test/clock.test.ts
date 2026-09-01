import { describe, expect, it } from 'vitest';

import { systemClock } from '../src/ports/clock.js';

describe('system clock port', () => {
  it('returns timezone-aware instants (Date)', () => {
    const now = systemClock.now();
    expect(now).toBeInstanceOf(Date);
    expect(Number.isFinite(now.getTime())).toBe(true);
  });
});
