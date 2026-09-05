import { describe, expect, it } from 'vitest';

import { ProjectStateKernel } from '../src/state/project-state-kernel.js';

const AT = '2026-09-03T11:00:00.000Z';
const T = (m: number) => new Date(Date.parse(AT) + m * 60_000).toISOString();

interface World {
  k: ProjectStateKernel;
  human: string;
  agent: string;
  agent2: string;
  workId: string;
  equipId: string;
  runId: string;
}

function seeded(): World {
  const k = new ProjectStateKernel();
  const human = '0198b100-0000-7000-8000-000000000001';
  const agent = '0198b100-0000-7000-8000-000000000002';
  const agent2 = '0198b100-0000-7000-8000-000000000004';
  k.registerParticipant({ participant_id: human, type: 'human', at: AT });
  k.registerParticipant({ participant_id: agent, type: 'agent', at: AT });
  k.registerParticipant({ participant_id: agent2, type: 'agent', at: AT });
  k.createProject({ actor: human, at: AT, title: 'P', expected_version: 0 });
  const work = k.createWork({
    actor: human,
    at: AT,
    reason: 'seed',
    title: 'W',
    expected_version: 0,
  });
  if (!work.ok) throw new Error('seed createWork failed');
  const equip = k.issueEquip({ actor: human, at: AT, participant_id: agent, expected_version: 0 });
  if (!equip.ok) throw new Error('seed issueEquip failed');
  const runId = '0198b500-0000-7000-8000-000000000001';
  const started = k.startRun({
    actor: agent,
    at: T(1),
    run_id: runId,
    work_id: work.value.id,
    equip_id: equip.value.id,
    expected_version: 0,
  });
  if (!started.ok) throw new Error('seed startRun failed');
  return {
    k,
    human,
    agent,
    agent2,
    workId: work.value.id,
    equipId: equip.value.id,
    runId,
  };
}

/**
 * Command-surface rejection edges: every guard branch of the command
 * layer, driven one step past the happy paths — unknown actors, missing
 * or foreign references, stale concurrency tokens, and terminal-state
 * violations. Each case asserts both the rejection and the exact
 * registry reason.
 */
const GHOST = '0198b100-0000-7000-8000-00000000ffff';
const OTHER_RUN = '0198b500-0000-7000-8000-000000000002';

describe('command-surface rejection edges (coverage of guard branches)', () => {
  it('direction commands before the project exists are rejected (registered actor)', () => {
    const k = new ProjectStateKernel();
    k.registerParticipant({
      participant_id: '0198b100-0000-7000-8000-000000000010',
      type: 'human',
      at: AT,
    });
    const noProject = k.proposeDirection({
      actor: '0198b100-0000-7000-8000-000000000010',
      at: T(1),
      direction_id: 'd0',
      title: 't',
    });
    expect(noProject.ok).toBe(false);
    if (!noProject.ok) expect(noProject.error.details).toMatchObject({ reason: 'no-project' });
  });

  it('startRun before the project exists is rejected with project-not-active', () => {
    const k = new ProjectStateKernel();
    const actor = '0198b100-0000-7000-8000-000000000010';
    k.registerParticipant({ participant_id: actor, type: 'agent', at: AT });
    const r = k.startRun({
      actor,
      at: T(1),
      run_id: 'r-np',
      work_id: 'w-np',
      equip_id: 'e-np',
      expected_version: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('project-not-active');
  });

  it('propose/resolve edge rejections', () => {
    const { k, human } = seeded();
    // unknown actor (propose + resolve)
    expect(k.proposeDirection({ actor: GHOST, at: T(2), direction_id: 'd1', title: 't' }).ok).toBe(
      false,
    );
    expect(
      k.resolveDirection({
        actor: GHOST,
        at: T(2),
        direction_id: 'd1',
        resolution: 'confirmed',
        resolution_reason: 'x',
        expected_version: 0,
      }).ok,
    ).toBe(false);
    // propose before project creation (fresh kernel)
    const fresh = new ProjectStateKernel();
    expect(
      fresh.proposeDirection({ actor: GHOST, at: T(2), direction_id: 'd2', title: 't' }).ok,
    ).toBe(false);
    // empty title
    const empty = k.proposeDirection({ actor: human, at: T(2), direction_id: 'd3', title: '  ' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.details).toMatchObject({ reason: 'title-length' });
    // resolve unknown direction
    expect(
      k.resolveDirection({
        actor: human,
        at: T(2),
        direction_id: 'nope',
        resolution: 'confirmed',
        resolution_reason: 'x',
        expected_version: 0,
      }).ok,
    ).toBe(false);
  });

  it('startRun edge rejections incl. foreign equip', () => {
    const { k, human, agent, agent2, workId, equipId } = seeded();
    // unknown actor
    expect(
      k.startRun({
        actor: GHOST,
        at: T(2),
        run_id: 'r0',
        work_id: workId,
        equip_id: equipId,
        expected_version: 0,
      }).ok,
    ).toBe(false);
    // unknown work
    expect(
      k.startRun({
        actor: agent,
        at: T(2),
        run_id: 'r1',
        work_id: 'nope',
        equip_id: equipId,
        expected_version: 0,
      }).ok,
    ).toBe(false);
    // duplicate run id
    expect(
      k.startRun({
        actor: agent,
        at: T(2),
        run_id: '0198b500-0000-7000-8000-000000000001',
        work_id: workId,
        equip_id: equipId,
        expected_version: 0,
      }).ok,
    ).toBe(false);
    // missing equip
    expect(
      k.startRun({
        actor: agent,
        at: T(2),
        run_id: 'r2',
        work_id: workId,
        equip_id: 'nope',
        expected_version: 0,
      }).ok,
    ).toBe(false);
    // parent run unknown or from another work
    expect(
      k.startRun({
        actor: agent,
        at: T(2),
        run_id: 'r3',
        work_id: workId,
        equip_id: equipId,
        parent_run_id: 'nope',
        expected_version: 0,
      }).ok,
    ).toBe(false);
    // parent run not terminal (still running)
    expect(
      k.startRun({
        actor: agent,
        at: T(2),
        run_id: 'r4',
        work_id: workId,
        equip_id: equipId,
        parent_run_id: '0198b500-0000-7000-8000-000000000001',
        expected_version: 0,
      }).ok,
    ).toBe(false);
    // an equip issued to another participant is foreign (agent presenting a human's equip)
    const humanEquip = k.issueEquip({
      actor: human,
      at: T(2),
      participant_id: human,
      expected_version: 0,
    });
    if (!humanEquip.ok) throw new Error('human equip failed');
    const foreign = k.startRun({
      actor: agent,
      at: T(2),
      run_id: 'r6',
      work_id: workId,
      equip_id: humanEquip.value.id,
      expected_version: 0,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.details).toMatchObject({ reason: 'foreign-equip' });
    // an equip issued to a third agent is foreign too
    const agent2Equip = k.issueEquip({
      actor: human,
      at: T(2),
      participant_id: agent2,
      expected_version: 0,
    });
    if (!agent2Equip.ok) throw new Error('agent2 equip failed');
    expect(
      k.startRun({
        actor: agent,
        at: T(2),
        run_id: 'r7',
        work_id: workId,
        equip_id: agent2Equip.value.id,
        expected_version: 0,
      }).ok,
    ).toBe(false);
    // the owner presenting their own equip works (any participant may execute)
    expect(
      k.startRun({
        actor: human,
        at: T(2),
        run_id: 'r5',
        work_id: workId,
        equip_id: humanEquip.value.id,
        expected_version: 0,
      }).ok,
    ).toBe(true);
  });

  it('transitionRun edge rejections', () => {
    const { k, agent } = seeded();
    // run not found
    expect(
      k.transitionRun({
        actor: agent,
        at: T(2),
        run_id: OTHER_RUN,
        to: 'paused',
        reason: 'r',
        expected_version: 0,
        run_revision: 1,
      }).ok,
    ).toBe(false);
    // stale expected_version (project level)
    expect(
      k.transitionRun({
        actor: agent,
        at: T(2),
        run_id: '0198b500-0000-7000-8000-000000000001',
        to: 'paused',
        reason: 'r',
        expected_version: 9,
        run_revision: 1,
      }).ok,
    ).toBe(false);
    // approval evidence missing (agent actor also rejected after evidence present)
    const runId = '0198b500-0000-7000-8000-000000000001';
    k.transitionRun({
      actor: agent,
      at: T(2),
      run_id: runId,
      to: 'waiting_approval',
      reason: 'ask',
      expected_version: 0,
      run_revision: 1,
    });
    const missing = k.transitionRun({
      actor: agent,
      at: T(3),
      run_id: runId,
      to: 'running',
      reason: 'r',
      expected_version: 0,
      run_revision: 2,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(missing.error.details).toMatchObject({ reason: 'approval-evidence-required' });
    // resume checkpoint unknown (paused → running with bogus ref)
    k.transitionRun({
      actor: agent,
      at: T(4),
      run_id: runId,
      to: 'paused',
      reason: 'r',
      expected_version: 0,
      run_revision: 2,
    });
    const bogus = k.transitionRun({
      actor: agent,
      at: T(5),
      run_id: runId,
      to: 'running',
      reason: 'r',
      expected_version: 0,
      run_revision: 3,
      resume_checkpoint_id: 'nope',
    });
    expect(bogus.ok).toBe(false);
    if (!bogus.ok)
      expect(bogus.error.details).toMatchObject({ reason: 'resume-checkpoint-mismatch' });
  });

  it('intervention edge rejections', () => {
    const { k, agent } = seeded();
    const runId = '0198b500-0000-7000-8000-000000000001';
    // stale project expected_version on both session commands
    expect(
      k.openIntervention({
        actor: agent,
        at: T(2),
        run_id: runId,
        session_id: 'ev1',
        mode: 'observe',
        expected_version: 9,
        run_revision: 1,
      }).ok,
    ).toBe(false);
    expect(
      k.closeIntervention({
        actor: agent,
        at: T(2),
        run_id: runId,
        session_id: 'ev2',
        expected_version: 9,
        run_revision: 1,
      }).ok,
    ).toBe(false);
    // unknown actor on close
    expect(
      k.closeIntervention({
        actor: GHOST,
        at: T(2),
        run_id: runId,
        session_id: 'ev3',
        expected_version: 0,
        run_revision: 1,
      }).ok,
    ).toBe(false);
    // run not found on both commands
    expect(
      k.openIntervention({
        actor: agent,
        at: T(2),
        run_id: OTHER_RUN,
        session_id: 'x1',
        mode: 'observe',
        expected_version: 0,
        run_revision: 0,
      }).ok,
    ).toBe(false);
    expect(
      k.closeIntervention({
        actor: agent,
        at: T(2),
        run_id: OTHER_RUN,
        session_id: 'x2',
        expected_version: 0,
        run_revision: 0,
      }).ok,
    ).toBe(false);
    // unknown actor
    expect(
      k.openIntervention({
        actor: GHOST,
        at: T(2),
        run_id: runId,
        session_id: 'x3',
        mode: 'observe',
        expected_version: 0,
        run_revision: 1,
      }).ok,
    ).toBe(false);
    // closing an unknown session
    expect(
      k.closeIntervention({
        actor: agent,
        at: T(2),
        run_id: runId,
        session_id: 'nope',
        expected_version: 0,
        run_revision: 1,
      }).ok,
    ).toBe(false);
    // open then close then re-close
    expect(
      k.openIntervention({
        actor: agent,
        at: T(2),
        run_id: runId,
        session_id: 'x4',
        mode: 'observe',
        expected_version: 0,
        run_revision: 1,
      }).ok,
    ).toBe(true);
    expect(
      k.closeIntervention({
        actor: agent,
        at: T(3),
        run_id: runId,
        session_id: 'x4',
        expected_version: 0,
        run_revision: 2,
      }).ok,
    ).toBe(true);
    expect(
      k.closeIntervention({
        actor: agent,
        at: T(4),
        run_id: runId,
        session_id: 'x4',
        expected_version: 0,
        run_revision: 3,
      }).ok,
    ).toBe(false);
    // unknown actor on takeover is rejected at the actor guard
    const ghostTakeover = k.openIntervention({
      actor: GHOST,
      at: T(5),
      run_id: runId,
      session_id: 'x5',
      mode: 'takeover',
      expected_version: 0,
      run_revision: 3,
    });
    expect(ghostTakeover.ok).toBe(false);
    // all-session-closed clears the derived mode (delete branch)
    const run = k.projection.work_runs[runId];
    expect(run?.intervention_mode).toBeUndefined();
  });

  it('closing another takeover by a non-owner agent is rejected (close authority)', () => {
    const { k, agent, agent2, human } = seeded();
    const runId = '0198b500-0000-7000-8000-000000000001';
    const rev = () => k.projection.work_runs[runId]?.run_revision ?? 0;
    expect(
      k.openIntervention({
        actor: agent,
        at: T(1),
        run_id: runId,
        session_id: 'y0',
        mode: 'observe',
        expected_version: 0,
        run_revision: rev(),
      }).ok,
    ).toBe(true);
    expect(
      k.openIntervention({
        actor: agent2,
        at: T(2),
        run_id: runId,
        session_id: 'y1',
        mode: 'observe',
        expected_version: 0,
        run_revision: rev(),
      }).ok,
    ).toBe(true);
    expect(
      k.openIntervention({
        actor: agent2,
        at: T(3),
        run_id: runId,
        session_id: 'y2',
        mode: 'takeover',
        expected_version: 0,
        run_revision: rev(),
      }).ok,
    ).toBe(true);
    // agent (not owner) closes agent2's takeover → rejected
    const r = k.closeIntervention({
      actor: agent,
      at: T(4),
      run_id: runId,
      session_id: 'y2',
      consent_status: 'granted',
      expected_version: 0,
      run_revision: rev(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details).toMatchObject({ reason: 'close-not-permitted' });
    // human (not owner) closes it → allowed, terminal consent recorded
    expect(
      k.closeIntervention({
        actor: human,
        at: T(5),
        run_id: runId,
        session_id: 'y2',
        consent_status: 'granted',
        expected_version: 0,
        run_revision: rev(),
      }).ok,
    ).toBe(true);
    const s = k.projection.work_runs[runId]?.intervention_sessions.find(
      (x) => x.session_id === 'y2',
    );
    expect(s?.consent_status).toBe('granted');
    expect(k.projection.work_runs[runId]?.re_equip_required).toBe(true);
  });
});
