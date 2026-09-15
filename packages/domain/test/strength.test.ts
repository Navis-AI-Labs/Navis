import { describe, expect, it } from 'vitest';

import {
  computeStrength,
  shapeSuggestion,
  acceptanceAnchor,
  NEUTRAL_BASELINE,
  OBSERVATION_FLOOR_WORKS,
  SUGGESTION_THRESHOLD,
  type StrengthInput,
} from '../src/state/strength.js';

const T0 = '2026-09-01T00:00:00.000Z'; // asset created
const T_ACCEPT = '2026-09-02T00:00:00.000Z'; // accepted
const T_EVAL = '2026-09-20T00:00:00.000Z'; // evaluation point

const OLD_ANCHOR = '2026-06-01T00:00:00.000Z'; // an old acceptance anchor so edges can be genuinely stale

function rows<const T extends { id: string }>(...items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((r) => [r.id, r]));
}

describe('acceptanceAnchor edge cases', () => {
  it('returns the latest accepted acceptance timestamp when multiple exist', () => {
    const asset = { id: 'a1', lifecycle: 'active' as const, created_at: T0 };
    const acceptances = rows(
      {
        id: 'acc1',
        asset_id: 'a1',
        result: 'accepted' as const,
        created_at: '2026-09-02T00:00:00.000Z',
      },
      {
        id: 'acc2',
        asset_id: 'a1',
        result: 'accepted' as const,
        created_at: '2026-09-05T00:00:00.000Z',
      },
      {
        id: 'acc3',
        asset_id: 'a1',
        result: 'accepted' as const,
        created_at: '2026-09-03T00:00:00.000Z',
      },
    );
    const anchor = acceptanceAnchor(asset, acceptances);
    expect(anchor).toBe('2026-09-05T00:00:00.000Z');
  });

  it('returns asset creation time when no accepted acceptances exist', () => {
    const asset = { id: 'a1', lifecycle: 'active' as const, created_at: T0 };
    const acceptances = rows({
      id: 'acc1',
      asset_id: 'a1',
      result: 'rejected' as const,
      created_at: '2026-09-05T00:00:00.000Z',
    });
    const anchor = acceptanceAnchor(asset, acceptances);
    expect(anchor).toBe(T0);
  });

  it('filters out non-matching asset_id acceptances', () => {
    const asset = { id: 'a1', lifecycle: 'active' as const, created_at: T0 };
    const acceptances = rows({
      id: 'acc1',
      asset_id: 'other',
      result: 'accepted' as const,
      created_at: '2026-09-05T00:00:00.000Z',
    });
    const anchor = acceptanceAnchor(asset, acceptances);
    expect(anchor).toBe(T0);
  });
});

function baseInput(overrides?: Partial<StrengthInput>): StrengthInput {
  return {
    asset: { id: 'a1', lifecycle: 'active', created_at: T0 },
    acceptances: rows({ id: 'acc1', asset_id: 'a1', result: 'accepted', created_at: T_ACCEPT }),
    deliveries: {},
    holds: {},
    works: {},
    evaluationAt: T_EVAL,
    ...overrides,
  };
}

/** A stale-referenced asset: old anchor, one genuinely post-anchor but aged edge. */
function staleAssetInput(): StrengthInput {
  return baseInput({
    asset: { id: 'a1', lifecycle: 'active', created_at: OLD_ANCHOR },
    acceptances: rows({ id: 'acc1', asset_id: 'a1', result: 'accepted', created_at: OLD_ANCHOR }),
    works: worksAfterAnchor(4),
    deliveries: rows({ id: 'd1', asset_id: 'a1', created_at: '2026-07-20T00:00:00.000Z' }),
  });
}

function worksAfterAnchor(count: number, startDay = 3): StrengthInput['works'] {
  return rows(
    ...Array.from({ length: count }, (_, i) => ({
      id: `w${String(i + 1)}`,
      created_at: `2026-09-${String(Math.min(28, startDay + i)).padStart(2, '0')}T00:00:00.000Z`,
    })),
  );
}

describe('strength evaluation determinism and range', () => {
  it('returns the identical score for identical input', () => {
    const input = baseInput({
      works: worksAfterAnchor(4),
      deliveries: rows({ id: 'd1', asset_id: 'a1', created_at: '2026-09-10T00:00:00.000Z' }),
    });
    const first = computeStrength(input);
    const second = computeStrength(input);
    expect(second.score).toBe(first.score);
    expect(second.signals).toEqual(first.signals);
  });

  it('stays inside the closed range [0.0, 1.0] across signal shapes', () => {
    const inputs = [
      baseInput(),
      baseInput({ works: worksAfterAnchor(10) }),
      baseInput({
        works: worksAfterAnchor(10),
        deliveries: rows(
          { id: 'd1', asset_id: 'a1', created_at: '2026-09-19T00:00:00.000Z' },
          { id: 'd2', asset_id: 'a1', created_at: '2026-09-18T00:00:00.000Z' },
          { id: 'd3', asset_id: 'a1', created_at: '2026-09-17T00:00:00.000Z' },
        ),
      }),
      baseInput({ works: worksAfterAnchor(10), evaluationAt: '2027-06-01T00:00:00.000Z' }),
    ];
    for (const input of inputs) {
      const { score } = computeStrength(input);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe('edge-set derivation', () => {
  it('counts only delivery and hold edges of this asset created after the anchor', () => {
    const input = baseInput({
      works: worksAfterAnchor(4),
      deliveries: rows(
        { id: 'd1', asset_id: 'a1', created_at: '2026-09-10T00:00:00.000Z' }, // counts
        { id: 'd2', asset_id: 'a1', created_at: '2026-09-01T00:00:00.000Z' }, // before anchor
        { id: 'd3', asset_id: 'other', created_at: '2026-09-10T00:00:00.000Z' }, // other asset
      ),
      holds: rows(
        { id: 'h1', asset_refs: ['a1', 'a2'], created_at: '2026-09-11T00:00:00.000Z' }, // counts
        { id: 'h2', asset_refs: ['a2'], created_at: '2026-09-11T00:00:00.000Z' }, // other asset
      ),
    });
    const { signals } = computeStrength(input);
    expect(signals.edge_count).toBe(2);
  });

  it('falls back to asset creation as the anchor when no accepted acceptance exists', () => {
    const input = baseInput({
      acceptances: rows({ id: 'acc1', asset_id: 'a1', result: 'rejected', created_at: T_ACCEPT }),
      deliveries: rows({ id: 'd1', asset_id: 'a1', created_at: '2026-09-01T12:00:00.000Z' }),
    });
    const { signals } = computeStrength(input);
    expect(signals.acceptance_anchor).toBe(T0); // T0 < delivery, so the edge counts
    expect(signals.edge_count).toBe(1);
  });
});

describe('observation floor', () => {
  it(`yields the neutral baseline below the floor (${String(OBSERVATION_FLOOR_WORKS)} works) even with edges`, () => {
    const input = baseInput({
      works: worksAfterAnchor(OBSERVATION_FLOOR_WORKS - 1),
      deliveries: rows({ id: 'd1', asset_id: 'a1', created_at: '2026-09-10T00:00:00.000Z' }),
    });
    const { score } = computeStrength(input);
    expect(score).toBe(NEUTRAL_BASELINE);
  });

  it('respects works-after-anchor: pre-anchor works never satisfy the floor', () => {
    const input = baseInput({
      works: {
        w0: { created_at: '2026-09-01T00:00:00.000Z' }, // before anchor
        ...worksAfterAnchor(OBSERVATION_FLOOR_WORKS - 1),
      },
    });
    const { score } = computeStrength(input);
    expect(score).toBe(NEUTRAL_BASELINE);
  });
});

describe('logical recency weighting', () => {
  it('depends on relative time and keeps missing reference observations neutral', () => {
    const makeInput = (origin: string): StrengthInput => {
      const at = (day: number) => new Date(Date.parse(origin) + day * 86_400_000).toISOString();
      return {
        asset: { id: 'a', lifecycle: 'active', created_at: at(0) },
        acceptances: {},
        deliveries: {},
        holds: {},
        works: {
          one: { created_at: at(1) },
          two: { created_at: at(2) },
          three: { created_at: at(3) },
        },
        evaluationAt: at(4),
      };
    };
    const first = computeStrength(makeInput('1970-01-01T00:00:00.000Z'));
    const second = computeStrength(makeInput('2026-01-01T00:00:00.000Z'));
    expect(first.score).toBe(NEUTRAL_BASELINE);
    expect(second.score).toBe(first.score);
    expect(shapeSuggestion(second, 'active')).toBeNull();
  });
  it('scores recent references higher than stale ones at equal edge counts', () => {
    const recentInput: StrengthInput = {
      ...staleAssetInput(),
      deliveries: rows({ id: 'd1', asset_id: 'a1', created_at: '2026-09-19T00:00:00.000Z' }),
    };
    const recentScore = computeStrength(recentInput).score;
    const staleScore = computeStrength(staleAssetInput()).score;
    expect(recentScore).toBeGreaterThan(staleScore);
  });

  it('declines a stale asset below the suggestion threshold so retirement is reachable', () => {
    const result = computeStrength(staleAssetInput());
    expect(result.score).toBeLessThan(SUGGESTION_THRESHOLD);
    const suggestion = shapeSuggestion(result, 'active');
    expect(suggestion).not.toBeNull();
    expect(suggestion?.requires_confirmation).toBe(true);
  });
});

describe('suggestion shaping', () => {
  it('carries the score, signals, recommended state, and confirmation flag as data', () => {
    const result = computeStrength(staleAssetInput());
    const suggestion = shapeSuggestion(result, 'active');
    expect(suggestion).toMatchObject({
      asset_id: 'a1',
      score: result.score,
      recommended_state: 'deprecated',
      requires_confirmation: true,
    });
    expect(suggestion?.signals.edge_count).toBe(1);
  });

  it('shapes no suggestion when no legal transition exists from the lifecycle', () => {
    const result = computeStrength(staleAssetInput());
    expect(result.score).toBeLessThan(SUGGESTION_THRESHOLD);
    expect(shapeSuggestion(result, 'archived')).toBeNull(); // archived is terminal
    expect(shapeSuggestion(result, 'candidate')).toBeNull(); // candidate cannot retire
  });

  it('shapes no suggestion above the threshold even from a retireable lifecycle', () => {
    const healthy = baseInput({
      works: worksAfterAnchor(6),
      deliveries: rows({ id: 'd1', asset_id: 'a1', created_at: '2026-09-19T00:00:00.000Z' }),
    });
    const result = computeStrength(healthy);
    expect(result.score).toBeGreaterThanOrEqual(SUGGESTION_THRESHOLD);
    expect(shapeSuggestion(result, 'active')).toBeNull();
  });
});

describe('evaluation point defenses', () => {
  it('rejects an evaluation point before the acceptance anchor', () => {
    const input = staleAssetInput();
    expect(() => computeStrength({ ...input, evaluationAt: '2026-05-01T00:00:00.000Z' })).toThrow(
      /precedes the acceptance anchor/,
    );
  });
});
it('rejects an invalid logical timestamp on any row', () => {
  const input = staleAssetInput();
  expect(() =>
    computeStrength({
      ...input,
      works: { w1: { created_at: 'not-a-timestamp' } },
      evaluationAt: T_EVAL,
    }),
  ).toThrow(/invalid logical timestamp/);
});
