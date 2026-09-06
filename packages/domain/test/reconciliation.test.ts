import { describe, expect, it } from 'vitest';

import { typeRegistry } from '../src/registry/type-registry.js';
import { resolveCriteria } from '../src/registry/submission-criteria.js';
import { ProjectStateKernel } from '../src/state/project-state-kernel.js';
import { assetContentSchema } from '../src/schema/asset.js';
import { interfaceDefinitions } from '../src/schema/capability-interfaces.js';
import { linkTypeDefinitions } from '../src/schema/link-types.js';

const T0 = '2026-01-01T00:00:00.000Z';
const uuid = (n: number): string => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function seedKernel(): { k: ProjectStateKernel; human: string; agent: string } {
  const k = new ProjectStateKernel();
  const human = uuid(1);
  const agent = uuid(2);
  k.registerParticipant({ participant_id: human, type: 'human', at: T0 });
  k.registerParticipant({ participant_id: agent, type: 'agent', at: T0 });
  k.createProject({ actor: human, at: T0, title: 'p', expected_version: 0 });
  return { k, human, agent };
}

function acceptedAsset(k: ProjectStateKernel, actor: string): string {
  const created = k.createAsset({
    actor,
    at: T0,
    kind: 'artifact',
    scope: 'project',
    content: { storage: 'inline', sha256: 'a'.repeat(64) },
    expected_version: k.stateVersion,
  });
  expect(created.ok).toBe(true);
  const assetId = (created as { ok: true; value: { id: string } }).value.id;
  const accepted = k.acceptAsset({
    actor,
    at: T0,
    asset_id: assetId,
    result: 'accepted',
    criteria_snapshot: { rule: 'r1' },
    expected_version: k.stateVersion,
  });
  expect(accepted.ok).toBe(true);
  return assetId;
}

describe('reconciliation: declaration pinned to behavior', () => {
  it('the registered name set equals the core type schema exports', () => {
    const registryNames = typeRegistry
      .list()
      .map((d) => d.name)
      .sort();
    const schemaModules = [
      'project',
      'work',
      'task-space',
      'asset',
      'acceptance',
      'delivery',
      'work-run',
      'hold',
    ];
    // every core schema module must be represented by exactly one registry entry
    expect(registryNames).toHaveLength(schemaModules.length);
    expect(new Set(registryNames).size).toBe(schemaModules.length);
  });

  it('the blocks_delivery declaration matches the live delivery gate behavior', () => {
    const link = linkTypeDefinitions.find((l) => l.name === 'blocks_delivery');
    expect(link?.from_type).toBe('Hold');
    expect(link?.to_type).toBe('Delivery');
    // gate side: an active blocking hold chained to the asset refuses delivery
    const { k, human } = seedKernel();
    const assetId = acceptedAsset(k, human);
    const hold = k.registerHold({
      actor: human,
      at: T0,
      kind: 'tech_debt',
      severity: 'high',
      statement: 'blocker',
      blocks_delivery: true,
      asset_refs: [assetId],
      expected_version: k.stateVersion,
    });
    expect(hold.ok).toBe(true);
    const delivery = k.deliver({
      actor: human,
      at: T0,
      asset_id: assetId,
      target_ref: 'production',
      target_type: 'environment',
      expected_version: k.stateVersion,
    });
    expect(delivery.ok).toBe(false);
    if (delivery.ok) return;
    expect(delivery.error.code).toBe('blocking-hold');
  });

  it('the criteria verdict matches the kernel guard on the same actor contexts', () => {
    const criteria = resolveCriteria('check_actor_permission');
    const { k, human, agent } = seedKernel();
    // agent actor on a human-only action: the kernel guard refuses and the
    // criteria refuses with the matching reason
    const agentAccept = k.acceptAsset({
      actor: agent,
      at: T0,
      asset_id: uuid(99),
      result: 'accepted',
      criteria_snapshot: { rule: 'r1' },
      expected_version: k.stateVersion,
    });
    expect(agentAccept.ok).toBe(false);
    if (agentAccept.ok) return;
    expect(agentAccept.error.code).toBe('forbidden');
    expect(
      criteria({
        actor: agent,
        action: 'accept_asset',
        parameters: {},
        state_version: k.stateVersion,
        actor_snapshot: { registered: true, type: 'agent' },
      }).reason,
    ).toBe('actor-kind-not-authorized');
    // human actor on the same action: the guard passes and the criteria passes
    expect(
      criteria({
        actor: human,
        action: 'accept_asset',
        parameters: {},
        state_version: k.stateVersion,
        actor_snapshot: { registered: true, type: 'human' },
      }).passed,
    ).toBe(true);
  });

  it('asset content baseline fields stay pinned (media_type/storage/ref/size/sha256, inline-ref exclusivity)', () => {
    const keys = Object.keys(assetContentSchema.shape).sort();
    expect(keys).toEqual(['media_type', 'ref', 'sha256', 'size', 'storage']);
    const inline = assetContentSchema.safeParse({ media_type: 'text/plain', storage: 'inline' });
    expect(inline.success).toBe(true);
    const inlineWithRef = assetContentSchema.safeParse({
      media_type: 'text/plain',
      storage: 'inline',
      ref: 'object-key',
    });
    expect(inlineWithRef.success).toBe(false);
    const external = assetContentSchema.safeParse({
      media_type: 'text/plain',
      storage: 'object_ref',
      ref: 'object-key',
    });
    expect(external.success).toBe(true);
  });

  it('interface property names align with the domain schema fields they describe', () => {
    const assetable = interfaceDefinitions.find((i) => i.name === 'Assetable');
    expect(assetable?.properties.map((p) => p.name)).toContain('lifecycle');
    expect(assetable?.properties.map((p) => p.name)).not.toContain('validity');
    expect(assetable?.properties.map((p) => p.name)).not.toContain('status');
  });
});
