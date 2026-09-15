import { describe, it, expect } from 'vitest';
import { acceptanceAnchor, computeStrength } from '../src/state/strength.js';
import type {
  StrengthAssetRow,
  StrengthAcceptanceRow,
  StrengthHoldRow,
  StrengthInput,
} from '../src/state/strength.js';

const AT = '2026-09-02T00:00:00.000Z';
const LATER = '2026-09-03T00:00:00.000Z';
const EVEN_LATER = '2026-09-04T00:00:00.000Z';
const ASSET_ID = '0198b100-0000-7000-8000-000000000001';

describe('Snapshot strength edge cases', () => {
  describe('acceptanceAnchor line 95', () => {
    it('updates latest when finding newer accepted acceptance', () => {
      const asset: StrengthAssetRow = {
        id: ASSET_ID,
        created_at: AT,
        lifecycle: 'active',
      };

      const acceptances: Record<string, StrengthAcceptanceRow> = {
        acc1: {
          asset_id: ASSET_ID,
          result: 'accepted',
          created_at: AT,
          deleted_at: undefined,
        },
        acc2: {
          asset_id: ASSET_ID,
          result: 'accepted',
          created_at: LATER, // newer
          deleted_at: undefined,
        },
      };

      const anchor = acceptanceAnchor(asset, acceptances);
      expect(anchor).toBe(LATER);
    });

    it('falls back to asset created_at when no accepted acceptances exist', () => {
      const asset: StrengthAssetRow = {
        id: ASSET_ID,
        created_at: AT,
        lifecycle: 'candidate',
      };

      const acceptances: Record<string, StrengthAcceptanceRow> = {
        acc1: {
          asset_id: ASSET_ID,
          result: 'rejected',
          created_at: LATER,
          deleted_at: undefined,
        },
      };

      const anchor = acceptanceAnchor(asset, acceptances);
      expect(anchor).toBe(AT);
    });
  });

  describe('computeStrength line 127', () => {
    it('processes hold references created after anchor', () => {
      const asset: StrengthAssetRow = {
        id: ASSET_ID,
        created_at: AT,
        lifecycle: 'active',
      };

      const hold: StrengthHoldRow = {
        asset_refs: [ASSET_ID],
        created_at: LATER,
        deleted_at: undefined,
      };

      const input: StrengthInput = {
        asset,
        acceptances: {},
        deliveries: {},
        holds: { hold1: hold },
        works: {},
        evaluationAt: EVEN_LATER,
      };

      const result = computeStrength(input);
      expect(result.signals.edge_count).toBeGreaterThan(0);
    });
  });
});
