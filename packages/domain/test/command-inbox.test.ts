import { describe, expect, it } from 'vitest';

import { hashCommandPayload, inboxErrors } from '../src/index.js';

describe('hashCommandPayload', () => {
  it('fingerprints identically regardless of object key order', () => {
    const a = { actor: 'p', note: 'x', items: [1, 2] };
    const b = { note: 'x', items: [1, 2], actor: 'p' };
    expect(hashCommandPayload(a)).toBe(hashCommandPayload(b));
  });

  it('differs for every content difference', () => {
    const base = { actor: 'p' };
    expect(hashCommandPayload(base)).not.toBe(hashCommandPayload({ actor: 'q' }));
    expect(hashCommandPayload({ n: 1 })).not.toBe(hashCommandPayload({ n: '1' }));
    expect(hashCommandPayload(base)).not.toBe(hashCommandPayload({ actor: 'p', extra: 0 }));
  });

  it('tags the digest format', () => {
    expect(hashCommandPayload({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('refuses non-canonical inputs (throws, never silently hashes)', () => {
    expect(() => hashCommandPayload({ n: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe('inboxErrors', () => {
  it('stabilizes the claim-failure vocabulary', () => {
    expect(inboxErrors.collision().message).toBe('idempotency-key-collides-with-different-payload');
    expect(inboxErrors.unknownKey().message).toBe('idempotency-key-has-no-claim');
  });
});
