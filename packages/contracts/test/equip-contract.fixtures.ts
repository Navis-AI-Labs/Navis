/**
 * Golden fixture for the issued-equip contract, hand-maintained from the
 * kernel's issued shape (never generated from domain code — D1). The
 * drift test in equip-contract.test.ts pins this key set; if either the
 * contract or the domain's issued shape moves, review must update both
 * sides deliberately.
 */

export const issuedEquipFixture = {
  id: '01923b10-4a81-7010-9c22-3aa2f9c1d001',
  state_version: 12,
  work_id: '01923b10-4a82-7020-9c23-3aa2f9c1d002',
  participant_id: '01923b10-4a83-7030-9c24-3aa2f9c1d003',
  causal_snapshot: {
    '01923b10-4a83-7030-9c24-3aa2f9c1d003': 7,
  },
  verified_facts: ['direction confirmed: align acceptance criteria'],
  active_assets: ['01923b10-4a84-7040-9c25-3aa2f9c1d004'],
  active_holds: [],
  boundary: 'front-end only; no schema migrations',
  acceptance_criteria: ['unit suite green', 'review recorded'],
  allowed_actions: ['work.record_progress', 'work.return'],
  issued_at: '2026-09-14T10:00:00.000Z',
  status: 'active',
} as const;
