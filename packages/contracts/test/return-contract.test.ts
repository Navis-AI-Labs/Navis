import { describe, expect, it } from 'vitest';

import {
  createReturnVersionConflictProblem,
  parseReturnSubmission,
  parseReturnSubmissionTolerant,
  returnRejectionCodes,
  returnResultSchema,
  returnVersionConflictType,
} from '../src/return-contract.js';

const validSubmission = {
  equip_id: '01923b10-4a81-7010-9c22-3aa2f9c1d001',
  expected_version: 7,
  candidates: [
    { kind: 'asset', provenance: 'transcript://session-1#turn-2', content: { title: 'a' } },
    { kind: 'hold' },
  ],
  effects: [{ asset_ref: '01923b10-4a84-7040-9c25-3aa2f9c1d004', description: 'rebuilt' }],
  causal_context: { '01923b10-4a83-7030-9c24-3aa2f9c1d003': 3 },
} as const;

describe('return submission contract', () => {
  it('accepts a valid submission and exposes only declared fields', () => {
    expect(parseReturnSubmission(validSubmission)).toEqual(validSubmission);
  });

  it('consumer-tolerant parsing strips undeclared envelope fields, including forged ones', () => {
    // On the read side the forged key is stripped like any undeclared field
    // — the typed result can never carry caller identity. Written rejection
    // is pinned above on the producer-strict path that gates the edge.
    const withExtra = { ...validSubmission, actor: 'x', edge_extension_tag: 'future' };
    const parsed = parseReturnSubmissionTolerant(withExtra);
    expect(parsed).toEqual(validSubmission);
    expect('actor' in parsed).toBe(false);
    expect('edge_extension_tag' in parsed).toBe(false);
  });

  it('rejects candidate seeds carrying forged lifecycle or scope', () => {
    for (const forged of ['lifecycle', 'scope'] as const) {
      const bad = {
        ...validSubmission,
        candidates: [{ kind: 'asset', [forged]: 'active' }],
      };
      // strict object rejects the undeclared key directly …
      const result = parseAttempt(bad);
      expect(result).toBe(false);
    }
  });

  it('rejects body-carried actor and timestamp (identity is edge-injected)', () => {
    for (const forged of ['actor', 'timestamp', 'at'] as const) {
      const result = parseAttempt({ ...validSubmission, [forged]: 'x' });
      expect(result).toBe(false);
    }
  });

  it('rejects negative or non-integer expected_version', () => {
    for (const version of [-1, 0.5, '7']) {
      expect(parseAttempt({ ...validSubmission, expected_version: version })).toBe(false);
    }
  });

  it('models the result as counts with an optional conflict flag', () => {
    expect(returnResultSchema.parse({ absorbed_candidates: 2, absorbed_effects: 1 })).toEqual({
      absorbed_candidates: 2,
      absorbed_effects: 1,
    });
    expect(
      returnResultSchema.parse({
        absorbed_candidates: 0,
        absorbed_effects: 0,
        conflict_marked: true,
      }),
    ).toEqual({ absorbed_candidates: 0, absorbed_effects: 0, conflict_marked: true });
    expect(
      returnResultSchema.safeParse({ absorbed_candidates: 1, conflict_marked: false }).success,
    ).toBe(false);
  });

  it('version-conflict rejection rides the Problem Details profile with a stable token and no internals', () => {
    const problem = createReturnVersionConflictProblem({
      expected: 7,
      actual: 9,
      request_id: 'req-1234',
    });
    expect(problem.status).toBe(409);
    expect(problem.type).toBe(returnVersionConflictType);
    expect(problem.code).toBe(returnRejectionCodes.versionConflict);
    const serialized = JSON.stringify(problem);
    expect(serialized).not.toContain('kernel');
    expect(serialized).not.toContain('row');
    expect(serialized).not.toContain('projection');
  });
});

/* parseAttempt is a test-side probe: parse throws on rejection, we only
 * want a boolean here. */
function parseAttempt(value: unknown): boolean {
  try {
    parseReturnSubmission(value);
    return true;
  } catch {
    return false;
  }
}
