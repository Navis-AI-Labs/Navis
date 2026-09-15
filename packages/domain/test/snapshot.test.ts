import { describe, expect, it } from 'vitest';

import { serializeProjectionState, extractProjectionState } from '../src/state/snapshot.js';
import { ProjectStateKernel } from '../src/state/project-state-kernel.js';

const T0 = '2026-01-01T00:00:00.000Z';

function seedKernel(): { k: ProjectStateKernel; human: string; agent: string } {
  const k = new ProjectStateKernel();
  const human = '01900000-0000-7000-8000-000000000001';
  const agent = '01900000-0000-7000-8000-000000000002';
  k.registerParticipant({ participant_id: human, type: 'human', at: T0 });
  k.registerParticipant({ participant_id: agent, type: 'agent', at: T0 });
  k.createProject({ actor: human, at: T0, title: 'Test Project', expected_version: 0 });
  return { k, human, agent };
}

describe('snapshot: serializeProjectionState', () => {
  it('serializes a minimal projection to a snapshot object', () => {
    const { k } = seedKernel();
    const snapshot = serializeProjectionState(k.projection);

    expect(snapshot).toHaveProperty('participants');
    expect(snapshot).toHaveProperty('project');
    expect(snapshot).toHaveProperty('assets');
    expect(snapshot).toHaveProperty('acceptances');
    expect(snapshot).toHaveProperty('deliveries');
    expect(snapshot).toHaveProperty('holds');
    expect(snapshot).toHaveProperty('works');
    expect(snapshot).toHaveProperty('equips');
    expect(snapshot).toHaveProperty('intended_directions');
    expect(snapshot).toHaveProperty('policy');

    expect(Object.keys(snapshot.participants)).toHaveLength(2);
    expect(snapshot.project).toHaveProperty('title', 'Test Project');
  });

  it('includes all asset fields after creating an asset', () => {
    const { k, human } = seedKernel();
    const result = k.createAsset({
      actor: human,
      at: T0,
      kind: 'artifact',
      scope: 'project',
      content: { media_type: 'text/plain', storage: 'inline', sha256: 'a'.repeat(64) },
      expected_version: 0,
    });
    expect(result.ok).toBe(true);
    const assetId = (result as { ok: true; value: { id: string } }).value.id;

    const snapshot = serializeProjectionState(k.projection);
    const asset = snapshot.assets[assetId];
    if (asset === undefined) throw new Error('fixture: asset missing');
    expect(asset.id).toBe(assetId);
    expect(asset.lifecycle).toBe('candidate');
    expect(asset.kind).toBe('artifact');
    expect(asset.scope).toBe('project');
    expect(asset.content).toEqual({
      media_type: 'text/plain',
      storage: 'inline',
      sha256: 'a'.repeat(64),
    });
  });

  it('includes acceptance records after asset acceptance', () => {
    const { k, human } = seedKernel();
    const assetResult = k.createAsset({
      actor: human,
      at: T0,
      kind: 'artifact',
      scope: 'project',
      content: { media_type: 'text/plain', storage: 'inline', sha256: 'a'.repeat(64) },
      expected_version: 0,
    });
    const assetId = (assetResult as { ok: true; value: { id: string } }).value.id;

    const acceptResult = k.acceptAsset({
      actor: human,
      at: T0,
      asset_id: assetId,
      result: 'accepted',
      criteria_snapshot: { rule: 'test-rule' },
      expected_version: k.stateVersion,
    });
    expect(acceptResult.ok).toBe(true);

    const snapshot = serializeProjectionState(k.projection);
    const acceptances = Object.values(snapshot.acceptances).filter((a) => a.asset_id === assetId);

    expect(acceptances).toHaveLength(1);
    const acceptance = acceptances[0];
    if (acceptance === undefined) throw new Error('fixture: acceptance missing');
    expect(acceptance.result).toBe('accepted');
    expect(acceptance.criteria_snapshot).toEqual({ rule: 'test-rule' });
  });

  it('includes delivery records after asset delivery', () => {
    const { k, human } = seedKernel();
    const assetResult = k.createAsset({
      actor: human,
      at: T0,
      kind: 'artifact',
      scope: 'project',
      content: { media_type: 'text/plain', storage: 'inline', sha256: 'a'.repeat(64) },
      expected_version: 0,
    });
    const assetId = (assetResult as { ok: true; value: { id: string } }).value.id;

    k.acceptAsset({
      actor: human,
      at: T0,
      asset_id: assetId,
      result: 'accepted',
      criteria_snapshot: { rule: 'test-rule' },
      expected_version: k.stateVersion,
    });

    const deliverResult = k.deliver({
      actor: human,
      at: T0,
      asset_id: assetId,
      target_ref: 'main',
      target_type: 'production',
      expected_version: k.stateVersion,
    });
    expect(deliverResult.ok).toBe(true);

    const snapshot = serializeProjectionState(k.projection);
    const deliveries = Object.values(snapshot.deliveries).filter((d) => d.asset_id === assetId);

    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0];
    if (delivery === undefined) throw new Error('fixture: delivery missing');
    expect(delivery.target_ref).toBe('main');
    expect(delivery.target_type).toBe('production');
  });

  it('includes hold records after registering a hold', () => {
    const { k, agent } = seedKernel();
    const holdResult = k.registerHold({
      actor: agent,
      at: T0,
      kind: 'bug',
      severity: 'high',
      statement: 'Critical bug found',
      expected_version: 0,
    });
    expect(holdResult.ok).toBe(true);
    const holdId = (holdResult as { ok: true; value: { id: string } }).value.id;

    const snapshot = serializeProjectionState(k.projection);
    const hold = snapshot.holds[holdId];
    if (hold === undefined) throw new Error('fixture: hold missing');
    expect(hold.kind).toBe('bug');
    expect(hold.severity).toBe('high');
    expect(hold.statement).toBe('Critical bug found');
  });

  it('includes work records after creating work', () => {
    const { k, human } = seedKernel();
    const workResult = k.createWork({
      actor: human,
      at: T0,
      title: 'Test Work',
      reason: 'Testing work creation',
      expected_version: 0,
    });
    expect(workResult.ok).toBe(true);
    const workId = (workResult as { ok: true; value: { id: string } }).value.id;

    const snapshot = serializeProjectionState(k.projection);
    const work = snapshot.works[workId];
    if (work === undefined) throw new Error('fixture: work missing');
    expect(work.title).toBe('Test Work');
  });

  it('includes equip records after issuing equip', () => {
    const { k, agent } = seedKernel();
    const equipResult = k.issueEquip({
      actor: agent,
      at: T0,
      expected_version: 0,
    });
    expect(equipResult.ok).toBe(true);
    const equipId = (equipResult as { ok: true; value: { id: string } }).value.id;

    const snapshot = serializeProjectionState(k.projection);
    const equip = snapshot.equips[equipId];
    if (equip === undefined) throw new Error('fixture: equip missing');
    expect(equip.id).toBe(equipId);
  });

  it('includes direction records after proposing a direction', () => {
    const { k, human } = seedKernel();
    const directionId = '01900000-0000-7000-8000-000000000300';
    const dirResult = k.proposeDirection({
      actor: human,
      at: T0,
      direction_id: directionId,
      title: 'New Direction',
    });
    expect(dirResult.ok).toBe(true);

    const snapshot = serializeProjectionState(k.projection);
    const direction = snapshot.intended_directions[directionId];
    if (direction === undefined) throw new Error('fixture: direction missing');
    expect(direction.title).toBe('New Direction');
  });

  it('includes policy when policy is updated', () => {
    const { k, human } = seedKernel();
    const policyUpdate = k.updatePolicy({
      actor: human,
      at: T0,
      reason: 'Update capture policy',
      event_count_window: 1000,
      time_window_days: 14,
      expected_version: 0,
    });
    expect(policyUpdate.ok).toBe(true);

    const snapshot = serializeProjectionState(k.projection);

    expect(snapshot.policy).toBeDefined();
    expect(snapshot.policy?.event_count_window).toBe(1000);
    expect(snapshot.policy?.time_window_days).toBe(14);
  });
});

describe('snapshot: extractProjectionState', () => {
  it('round-trips: serialize then extract produces equivalent projection', () => {
    const { k, human, agent } = seedKernel();

    k.createAsset({
      actor: human,
      at: T0,
      kind: 'artifact',
      scope: 'project',
      content: { media_type: 'text/plain', storage: 'inline', sha256: 'a'.repeat(64) },
      expected_version: 0,
    });

    k.registerHold({
      actor: agent,
      at: T0,
      kind: 'bug',
      severity: 'high',
      statement: 'Test hold',
      expected_version: 0,
    });

    const original = k.projection;
    const serialized = serializeProjectionState(original);
    const restored = extractProjectionState(serialized);

    expect(restored.participants).toEqual(original.participants);
    expect(restored.project).toEqual(original.project);
    expect(restored.assets).toEqual(original.assets);
    expect(restored.holds).toEqual(original.holds);
  });

  it('restores a complex projection with all entity types', () => {
    const { k, human, agent } = seedKernel();

    const assetResult = k.createAsset({
      actor: human,
      at: T0,
      kind: 'artifact',
      scope: 'project',
      content: { media_type: 'text/plain', storage: 'inline', sha256: 'a'.repeat(64) },
      expected_version: 0,
    });
    const assetId = (assetResult as { ok: true; value: { id: string } }).value.id;

    k.acceptAsset({
      actor: human,
      at: T0,
      asset_id: assetId,
      result: 'accepted',
      criteria_snapshot: { rule: 'r1' },
      expected_version: k.stateVersion,
    });

    k.deliver({
      actor: human,
      at: T0,
      asset_id: assetId,
      target_ref: 'main',
      target_type: 'production',
      expected_version: k.stateVersion,
    });

    k.registerHold({
      actor: agent,
      at: T0,
      kind: 'bug',
      severity: 'high',
      statement: 'Bug',
      expected_version: k.stateVersion,
    });

    k.createWork({
      actor: human,
      at: T0,
      title: 'Work Item',
      reason: 'test',
      expected_version: k.stateVersion,
    });

    k.issueEquip({
      actor: agent,
      at: T0,
      expected_version: k.stateVersion,
    });

    const directionId = '01900000-0000-7000-8000-000000000300';
    k.proposeDirection({
      actor: human,
      at: T0,
      direction_id: directionId,
      title: 'Direction',
    });

    k.updatePolicy({
      actor: human,
      at: T0,
      reason: 'policy update',
      event_count_window: 1000,
      time_window_days: 14,
      expected_version: k.stateVersion,
    });

    const serialized = serializeProjectionState(k.projection);
    const restored = extractProjectionState(serialized);

    expect(Object.keys(restored.assets)).toHaveLength(Object.keys(k.projection.assets).length);
    expect(Object.keys(restored.acceptances)).toHaveLength(
      Object.keys(k.projection.acceptances).length,
    );
    expect(Object.keys(restored.deliveries)).toHaveLength(
      Object.keys(k.projection.deliveries).length,
    );
    expect(Object.keys(restored.holds)).toHaveLength(Object.keys(k.projection.holds).length);
    expect(Object.keys(restored.works)).toHaveLength(Object.keys(k.projection.works).length);
    expect(Object.keys(restored.equips)).toHaveLength(Object.keys(k.projection.equips).length);
    expect(Object.keys(restored.intended_directions)).toHaveLength(
      Object.keys(k.projection.intended_directions).length,
    );
    expect(restored.policy).toEqual(k.projection.policy);
  });

  it('handles empty collections in snapshot', () => {
    const emptyState = {
      seq: 0,
      participants: {},
      project: null,
      assets: {},
      acceptances: {},
      deliveries: {},
      holds: {},
      works: {},
      equips: {},
      intended_directions: {},
      checkpoints: {},
      effects: {},
      work_runs: {},
      policy: null,
    };

    const restored = extractProjectionState(emptyState);

    expect(restored.participants).toEqual({});
    expect(restored.project).toBeNull();
    expect(restored.assets).toEqual({});
    expect(restored.acceptances).toEqual({});
    expect(restored.deliveries).toEqual({});
    expect(restored.holds).toEqual({});
    expect(restored.works).toEqual({});
    expect(restored.equips).toEqual({});
    expect(restored.intended_directions).toEqual({});
    expect(restored.policy).toBeNull();
  });
});
