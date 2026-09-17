import { describe, expect, it } from 'vitest';

import { scopeVisibleForProject } from '../src/state/scope-visibility.js';
import { ProjectStateKernel } from '../src/index.js';

/*
 * The single rule owner for project derivation: one predicate, five levels.
 * Kernel-level acceptance scenarios pin each level — including levels the
 * issuance commands rarely mint today, so a later schema widening cannot
 * silently migrate them into the working contract.
 */

describe('scopeVisibleForProject', () => {
  it('project is visible', () => {
    expect(scopeVisibleForProject('project')).toBe(true);
  });
  it('participant is hidden', () => {
    expect(scopeVisibleForProject('participant')).toBe(false);
  });
  it('session is hidden', () => {
    expect(scopeVisibleForProject('session')).toBe(false);
  });
  it('task is hidden', () => {
    expect(scopeVisibleForProject('task')).toBe(false);
  });
  it('organization stays outside the project derivation', () => {
    expect(scopeVisibleForProject('organization')).toBe(false);
  });
});

describe('equip derivation honours the predicate at every level', () => {
  const HUMAN = '0198b100-0000-7000-8000-0000000000a1';
  const AT = '2026-09-03T09:00:00.000Z';

  function seeded(): ProjectStateKernel {
    const k = new ProjectStateKernel();
    const registered = k.registerParticipant({
      participant_id: HUMAN,
      type: 'human',
      at: AT,
    });
    if (!registered.ok) throw new Error('seed failed');
    const created = k.createProject({
      actor: HUMAN,
      at: AT,
      title: 'P',
      expected_version: 0,
    });
    if (!created.ok) throw new Error('seed failed');
    return k;
  }

  function createActiveAsset(
    k: ProjectStateKernel,
    scope: 'participant' | 'session' | 'task' | 'project',
  ): string {
    const created = k.createAsset({
      actor: HUMAN,
      at: AT,
      kind: 'artifact',
      scope,
      content: { media_type: 'text/plain', storage: 'inline', sha256: 'a'.repeat(64) },
      expected_version: k.stateVersion,
    });
    if (!created.ok) throw new Error(`createAsset(${scope}) failed`);
    const assetId = created.value.id;
    const accepted = k.acceptAsset({
      actor: HUMAN,
      at: AT,
      asset_id: assetId,
      result: 'accepted',
      criteria_snapshot: { rule: 'r1' },
      expected_version: k.stateVersion,
    });
    if (!accepted.ok) throw new Error(`acceptAsset(${scope}) failed`);
    return assetId;
  }

  it('only project-scope assets enter verified_facts and active_assets', () => {
    const k = seeded();
    const projectAsset = createActiveAsset(k, 'project');
    createActiveAsset(k, 'task');
    createActiveAsset(k, 'session');
    createActiveAsset(k, 'participant');

    const equip = k.issueEquip({ actor: HUMAN, at: AT, expected_version: 0 });
    if (!equip.ok) throw new Error('issueEquip failed');
    expect(equip.value.verified_facts).toEqual([projectAsset]);
    expect(equip.value.active_assets).toEqual([projectAsset]);
  });
});
