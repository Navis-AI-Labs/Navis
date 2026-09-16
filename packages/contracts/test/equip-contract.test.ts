import { describe, expect, it } from 'vitest';

import {
  encodeEquipContract,
  equipContractSchema,
  parseEquipContract,
} from '../src/equip-contract.js';
import { issuedEquipFixture } from './equip-contract.fixtures.js';

/*
 * The issued-equip key set is the public promise. Keep this list in sync
 * with the domain IssuedEquip interface by review; it is deliberately
 * hand-maintained (D1) so internal refactors of the kernel cannot move
 * the public contract silently.
 */
const issuedEquipKeyOrder = [
  'id',
  'state_version',
  'work_id',
  'participant_id',
  'causal_snapshot',
  'verified_facts',
  'active_assets',
  'active_holds',
  'boundary',
  'acceptance_criteria',
  'allowed_actions',
  'issued_at',
  'status',
] as const;

describe('equip contract', () => {
  it('parses the golden issued equip and exposes all declared fields', () => {
    expect(parseEquipContract(issuedEquipFixture)).toEqual(issuedEquipFixture);
  });

  it('fixture-drift pin: the contract declares exactly the issued key set', () => {
    expect(Object.keys(equipContractSchema.def.shape).sort()).toEqual(
      [...issuedEquipKeyOrder].sort(),
    );
    expect(Object.keys(issuedEquipFixture).sort()).toEqual([...issuedEquipKeyOrder].sort());
  });

  it('accepts optionals absent (minimal issued equip)', () => {
    const optionalKeys = new Set([
      'work_id',
      'participant_id',
      'boundary',
      'acceptance_criteria',
      'allowed_actions',
    ]);
    const minimal = Object.fromEntries(
      Object.entries(issuedEquipFixture).filter(([key]) => !optionalKeys.has(key)),
    );
    expect(parseEquipContract(minimal)).toEqual(minimal);
  });

  it('issued status is active-only', () => {
    expect(() => parseEquipContract({ ...issuedEquipFixture, status: 'stale' })).toThrow();
  });

  it('producer-strict rejects undeclared fields', () => {
    expect(() => encodeEquipContract({ ...issuedEquipFixture, secret_grant: true })).toThrow();
  });

  it('consumer-tolerant strips undeclared fields', () => {
    const parsed = parseEquipContract({ ...issuedEquipFixture, future_field: 1 });
    expect(parsed).toEqual(issuedEquipFixture);
  });

  it('allowed_actions carries no authorization semantics — parse exposes data only', () => {
    const parsed = parseEquipContract(issuedEquipFixture);
    expect(parsed.allowed_actions).toEqual(['work.record_progress', 'work.return']);
  });
});
