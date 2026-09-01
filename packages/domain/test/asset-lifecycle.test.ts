import { describe, expect, it } from 'vitest';

import { assertTransition, PURGE_AGE_THRESHOLD_DAYS } from '../src/schema/index.js';
import { schemaErrorTokens } from '../src/errors/schema.js';
import type { AssetLifecycle } from '../src/schema/index.js';

/** Test-local convenience: whether a regular (non-purge) transition is legal. */
function canTransition(from: AssetLifecycle, to: AssetLifecycle): boolean {
  return assertTransition(from, to).ok;
}

/**
 * Lifecycle transition tests over the 11 legal pairs of the accepted asset
 * verification (11/11 legal pass, 6/6 illegal reject) plus the
 * double-condition purge matrix and the contested-unreachable rule.
 */

const ALL_STATES: AssetLifecycle[] = [
  'candidate',
  'active',
  'superseded',
  'competitive_superseded',
  'deprecated',
  'archived',
  'rejected',
];

describe('asset lifecycle legal transitions ', () => {
  const legalPairs: [AssetLifecycle, AssetLifecycle][] = [
    ['candidate', 'active'],
    ['candidate', 'rejected'],
    ['active', 'superseded'],
    ['active', 'competitive_superseded'],
    ['active', 'deprecated'],
    ['active', 'archived'],
    ['superseded', 'archived'],
    ['competitive_superseded', 'active'],
    ['competitive_superseded', 'archived'],
    ['deprecated', 'archived'],
  ];

  it.each(legalPairs)('%s → %s passes', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('exactly 10 regular legal pairs; archived/rejected have no regular successors', () => {
    const legal = new Set(
      ALL_STATES.flatMap((from) =>
        ALL_STATES.filter((to) => canTransition(from, to)).map((to) => `${from}→${to}`),
      ),
    );
    expect(legal).toEqual(
      new Set([
        'candidate→active',
        'candidate→rejected',
        'active→superseded',
        'active→competitive_superseded',
        'active→deprecated',
        'active→archived',
        'superseded→archived',
        'competitive_superseded→active',
        'competitive_superseded→archived',
        'deprecated→archived',
      ]),
    );
  });
});

describe('asset lifecycle illegal transitions ', () => {
  const illegalPairs: [AssetLifecycle, AssetLifecycle][] = [
    ['candidate', 'archived'], // must activate before retiring
    ['candidate', 'superseded'], // cannot be superseded before activation
    ['candidate', 'competitive_superseded'],
    ['active', 'candidate'], // no rollback to candidate
    ['rejected', 'active'], // rejected is terminal
    ['rejected', 'archived'],
    ['rejected', 'candidate'],
    ['archived', 'active'], // terminal restart
    ['superseded', 'active'], // only competitive_superseded rolls back
    ['deprecated', 'active'],
  ];

  it.each(illegalPairs)('%s → %s is rejected with the registry token', (from, to) => {
    const result = assertTransition(from, to);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.urn).toBe(schemaErrorTokens['illegal-transition']);
      expect(result.error.details).toMatchObject({ from, to });
    }
  });
});

describe('purge double-condition gate', () => {
  it('rejects purge at 100 days even with double confirmation', () => {
    const result = assertTransition('archived', 'purged' as AssetLifecycle, {
      daysArchived: 100,
      doubleConfirmation: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.urn).toBe(schemaErrorTokens['purge-conditions-unmet']);
    }
  });

  it('rejects purge at 200 days without double confirmation', () => {
    const result = assertTransition('archived', 'purged' as AssetLifecycle, {
      daysArchived: 200,
      doubleConfirmation: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.urn).toBe(schemaErrorTokens['purge-conditions-unmet']);
    }
  });

  it('allows purge at 200 days with double confirmation', () => {
    const result = assertTransition('archived', 'purged' as AssetLifecycle, {
      daysArchived: 200,
      doubleConfirmation: true,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses purge from any non-archived state', () => {
    for (const from of ['candidate', 'active', 'deprecated', 'rejected'] as AssetLifecycle[]) {
      const result = assertTransition(from, 'purged' as AssetLifecycle, {
        daysArchived: 400,
        doubleConfirmation: true,
      });
      expect(result.ok, `${from}→purged must fail`).toBe(false);
    }
  });

  it('rejects purge when no gate input is provided at all', () => {
    const result = assertTransition('archived', 'purged' as AssetLifecycle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.urn).toBe(schemaErrorTokens['purge-conditions-unmet']);
      expect(result.error.details).toMatchObject({ days_archived: 0, double_confirmation: false });
    }
  });

  it('threshold constant is named and equals 180 days', () => {
    expect(PURGE_AGE_THRESHOLD_DAYS).toBe(180);
  });

  it('rejects non-lifecycle inputs with the illegal-transition token', () => {
    const badFrom = assertTransition('fortnite' as AssetLifecycle, 'active');
    expect(badFrom.ok).toBe(false);
    if (!badFrom.ok) expect(badFrom.error.urn).toBe(schemaErrorTokens['illegal-transition']);

    const badTo = assertTransition('active', 'fortnite' as AssetLifecycle);
    expect(badTo.ok).toBe(false);
    if (!badTo.ok) expect(badTo.error.urn).toBe(schemaErrorTokens['illegal-transition']);
  });
});

describe('contested is reserved, not reachable', () => {
  it('any transition targeting contested fails with not-enabled', () => {
    for (const from of ALL_STATES) {
      const result = assertTransition(from, 'contested' as AssetLifecycle);
      expect(result.ok, `${from}→contested must fail`).toBe(false);
      if (!result.ok) {
        expect(result.error.urn).toBe(schemaErrorTokens['not-enabled']);
      }
    }
  });
});
