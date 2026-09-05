import { describe, expect, it } from 'vitest';

import { ProjectStateKernel } from '../src/state/project-state-kernel.js';

/**
 * Intended-direction behavior: open proposing, the single terminal
 * human-only resolution with its mandatory reason, version neutrality
 * of direction events, and replay identity of the resolution fields.
 */

const AT = '2026-09-03T08:00:00.000Z';
const AT2 = '2026-09-03T08:05:00.000Z';

function seeded(): { k: ProjectStateKernel; human: string; agent: string } {
  const k = new ProjectStateKernel();
  const human = '0198b100-0000-7000-8000-000000000001';
  const agent = '0198b100-0000-7000-8000-000000000002';
  k.registerParticipant({ participant_id: human, type: 'human', at: AT });
  k.registerParticipant({ participant_id: agent, type: 'agent', at: AT });
  k.createProject({
    actor: human,
    at: AT,
    title: 'P',
    expected_version: 0,
  });
  return { k, human, agent };
}

describe('intended direction: propose', () => {
  it('any participant proposes; the record is projected with provenance', () => {
    const { k, agent } = seeded();
    const dirId = '0198b200-0000-7000-8000-000000000001';
    const r = k.proposeDirection({
      actor: agent,
      at: AT2,
      direction_id: dirId,
      title: 'Verify sharding',
    });
    expect(r.ok).toBe(true);
    const dir = k.projection.intended_directions[dirId];
    expect(dir?.status).toBe('proposed');
    expect(dir?.proposed_by).toBe(agent);
    expect(dir?.proposed_at).toBe(AT2);
  });

  it('direction events do not advance the state version', () => {
    const { k, human } = seeded();
    const before = k.stateVersion;
    k.proposeDirection({
      actor: human,
      at: AT2,
      direction_id: '0198b200-0000-7000-8000-000000000002',
      title: 'x',
    });
    expect(k.stateVersion).toBe(before);
  });

  it('proposal into a terminal project is rejected with project-not-active', () => {
    const { k, human } = seeded();
    k.setProjectStatus({
      actor: human,
      at: AT2,
      to: 'completed',
      reason: 'done',
      expected_version: 0,
    });
    const r = k.proposeDirection({
      actor: human,
      at: AT2,
      direction_id: '0198b200-0000-7000-8000-000000000003',
      title: 'late',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('project-not-active');
  });

  it('pausing does not block proposing (planning mutates nothing)', () => {
    const { k, human } = seeded();
    k.setProjectStatus({
      actor: human,
      at: AT2,
      to: 'paused',
      reason: 'wait',
      expected_version: 0,
    });
    const r = k.proposeDirection({
      actor: human,
      at: AT2,
      direction_id: '0198b200-0000-7000-8000-000000000004',
      title: 'plan during pause',
    });
    expect(r.ok).toBe(true);
  });

  it('duplicate direction id is rejected; unknown actor is rejected', () => {
    const { k, human } = seeded();
    const id = '0198b200-0000-7000-8000-000000000005';
    expect(k.proposeDirection({ actor: human, at: AT2, direction_id: id, title: 'a' }).ok).toBe(
      true,
    );
    const again = k.proposeDirection({ actor: human, at: AT2, direction_id: id, title: 'b' });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('forbidden');
    const ghost = k.proposeDirection({
      actor: '0198b100-0000-7000-8000-00000000ffff',
      at: AT2,
      direction_id: '0198b200-0000-7000-8000-000000000006',
      title: 'c',
    });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe('forbidden');
  });
});

describe('intended direction: resolve (human-only, terminal, reason-carrying)', () => {
  it('agent proposes, human confirms with reason; resolution recorded', () => {
    const { k, human, agent } = seeded();
    const id = '0198b200-0000-7000-8000-000000000007';
    k.proposeDirection({ actor: agent, at: AT2, direction_id: id, title: 'd' });
    const r = k.resolveDirection({
      actor: human,
      at: AT2,
      direction_id: id,
      resolution: 'confirmed',
      resolution_reason: 'fits R0 scope',
      expected_version: 0,
    });
    expect(r.ok).toBe(true);
    expect(k.projection.intended_directions[id]?.status).toBe('confirmed');
    expect(k.projection.intended_directions[id]?.resolution_reason).toBe('fits R0 scope');
  });

  it('agent resolution is rejected with zero pollution (no event, still proposed)', () => {
    const { k, human, agent } = seeded();
    const id = '0198b200-0000-7000-8000-000000000008';
    k.proposeDirection({ actor: human, at: AT2, direction_id: id, title: 'e' });
    const eventsBefore = k.events.length;
    const r = k.resolveDirection({
      actor: agent,
      at: AT2,
      direction_id: id,
      resolution: 'confirmed',
      resolution_reason: 'bot decides',
      expected_version: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    expect(k.events.length).toBe(eventsBefore);
    expect(k.projection.intended_directions[id]?.status).toBe('proposed');
  });

  it('empty reason is rejected with rationale-required', () => {
    const { k, human } = seeded();
    const id = '0198b200-0000-7000-8000-000000000009';
    k.proposeDirection({ actor: human, at: AT2, direction_id: id, title: 'f' });
    const r = k.resolveDirection({
      actor: human,
      at: AT2,
      direction_id: id,
      resolution: 'discarded',
      resolution_reason: '  ',
      expected_version: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('rationale-required');
  });

  it('resolution is terminal: re-resolving is rejected with zero pollution', () => {
    const { k, human } = seeded();
    const id = '0198b200-0000-7000-8000-00000000000a';
    k.proposeDirection({ actor: human, at: AT2, direction_id: id, title: 'g' });
    k.resolveDirection({
      actor: human,
      at: AT2,
      direction_id: id,
      resolution: 'confirmed',
      resolution_reason: 'ok',
      expected_version: 0,
    });
    const eventsBefore = k.events.length;
    const r = k.resolveDirection({
      actor: human,
      at: AT2,
      direction_id: id,
      resolution: 'discarded',
      resolution_reason: 'flip',
      expected_version: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    expect(k.events.length).toBe(eventsBefore);
    expect(k.projection.intended_directions[id]?.status).toBe('confirmed');
  });

  it('stale expected_version is rejected with version-conflict', () => {
    const { k, human } = seeded();
    const id = '0198b200-0000-7000-8000-00000000000b';
    k.proposeDirection({ actor: human, at: AT2, direction_id: id, title: 'h' });
    const r = k.resolveDirection({
      actor: human,
      at: AT2,
      direction_id: id,
      resolution: 'confirmed',
      resolution_reason: 'ok',
      expected_version: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('version-conflict');
  });
});

describe('intended direction: queries + replay identity', () => {
  it('views: all records visible; proposed-only filter is caller-side; nothing deleted', () => {
    const { k, human } = seeded();
    k.proposeDirection({
      actor: human,
      at: AT2,
      direction_id: '0198b200-0000-7000-8000-00000000000c',
      title: 'one',
    });
    k.proposeDirection({
      actor: human,
      at: AT2,
      direction_id: '0198b200-0000-7000-8000-00000000000d',
      title: 'two',
    });
    k.resolveDirection({
      actor: human,
      at: AT2,
      direction_id: '0198b200-0000-7000-8000-00000000000c',
      resolution: 'confirmed',
      resolution_reason: 'go',
      expected_version: 0,
    });
    const all = Object.values(k.projection.intended_directions);
    expect(all).toHaveLength(2);
    expect(all.filter((d) => d.status === 'proposed')).toHaveLength(1);
    expect(all.filter((d) => d.status === 'confirmed')).toHaveLength(1);
  });

  it('replay identity: rebuilt projection is canonical-JSON identical', () => {
    const { k, human, agent } = seeded();
    k.proposeDirection({
      actor: agent,
      at: AT2,
      direction_id: '0198b200-0000-7000-8000-00000000000e',
      title: 'a',
      detail: 'b',
    });
    k.proposeDirection({
      actor: human,
      at: AT2,
      direction_id: '0198b200-0000-7000-8000-00000000000f',
      title: 'c',
    });
    k.resolveDirection({
      actor: human,
      at: AT2,
      direction_id: '0198b200-0000-7000-8000-00000000000e',
      resolution: 'discarded',
      resolution_reason: 'dup',
      expected_version: 0,
    });
    const rebuilt = k.rebuildProjection();
    expect(JSON.parse(JSON.stringify(rebuilt.intended_directions))).toEqual(
      JSON.parse(JSON.stringify(k.projection.intended_directions)),
    );
  });
});
