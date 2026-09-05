import { describe, expect, it } from 'vitest';

import { assertWorkRunTransition } from '../src/schema/workrun.js';
import { ProjectStateKernel } from '../src/state/project-state-kernel.js';

/**
 * WorkRun execution behavior: the legal-pair table, the start gate
 * (equip freshness, ownership, parent-run chain), transition evidence
 * requirements, checkpoint payloads, and replay identity.
 */

const AT = '2026-09-03T09:00:00.000Z';
const T = (m: number) => new Date(Date.parse(AT) + m * 60_000).toISOString();

interface World {
  k: ProjectStateKernel;
  human: string;
  agent: string;
  workId: string;
  equipId: string;
}

function seeded(): World {
  const k = new ProjectStateKernel();
  const human = '0198b100-0000-7000-8000-000000000001';
  const agent = '0198b100-0000-7000-8000-000000000002';
  k.registerParticipant({ participant_id: human, type: 'human', at: AT });
  k.registerParticipant({ participant_id: agent, type: 'agent', at: AT });
  k.createProject({ actor: human, at: AT, title: 'P', expected_version: 0 });
  const work = k.createWork({
    actor: human,
    at: AT,
    reason: 'seed',
    title: 'W',
    expected_version: 0,
  });
  if (!work.ok) throw new Error('seed createWork failed');
  const workId = work.value.id;
  const equip = k.issueEquip({ actor: human, at: AT, participant_id: agent, expected_version: 0 });
  if (!equip.ok) throw new Error('seed issueEquip failed');
  const equipId = equip.value.id;
  return { k, human, agent, workId, equipId };
}

function startRun(w: World, runId: string, actor?: string): void {
  const r = w.k.startRun({
    actor: actor ?? w.agent,
    at: T(1),
    run_id: runId,
    work_id: w.workId,
    equip_id: w.equipId,
    expected_version: 0,
  });
  if (!r.ok) throw new Error(`startRun failed: ${JSON.stringify(r.error)}`);
}

describe('workrun: transition table (pure function)', () => {
  it('rejects statuses outside the enum with illegal-transition', () => {
    // the kernel only ever feeds projected statuses; the guard exists for
    // direct callers handing the table garbage
    const bad = assertWorkRunTransition('queued' as never, 'running');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('illegal-transition');
    const badTo = assertWorkRunTransition('running', 'teleported' as never);
    expect(badTo.ok).toBe(false);
    if (!badTo.ok) expect(badTo.error.code).toBe('illegal-transition');
  });

  it('accepts every legal pair and rejects representative illegal ones', () => {
    expect(assertWorkRunTransition('ready', 'running').ok).toBe(true);
    expect(assertWorkRunTransition('running', 'waiting_input').ok).toBe(true);
    expect(assertWorkRunTransition('waiting_input', 'running').ok).toBe(true);
    expect(assertWorkRunTransition('waiting_approval', 'cancelling').ok).toBe(true);
    expect(assertWorkRunTransition('paused', 'running').ok).toBe(true);
    expect(assertWorkRunTransition('cancelling', 'cancelled').ok).toBe(true);
    expect(assertWorkRunTransition('running', 'ready').ok).toBe(false);
    expect(assertWorkRunTransition('ready', 'paused').ok).toBe(false);
    expect(assertWorkRunTransition('cancelling', 'running').ok).toBe(false);
    expect(assertWorkRunTransition('completed', 'running').ok).toBe(false);
    expect(assertWorkRunTransition('failed', 'cancelled').ok).toBe(false);
    expect(assertWorkRunTransition('cancelled', 'ready').ok).toBe(false);
  });
});

describe('workrun: start gate', () => {
  it('starting with a current equip succeeds; revision = 1; input_state_version stamped', () => {
    const w = seeded();
    const runId = '0198b300-0000-7000-8000-000000000010';
    startRun(w, runId);
    const run = w.k.projection.work_runs[runId];
    expect(run?.status).toBe('running');
    expect(run?.run_revision).toBe(1);
    expect(run?.input_state_version).toBe(0);
  });

  it('execution_refs ride the started event and replay identically', () => {
    const w = seeded();
    const runId = '0198b300-0000-7000-8000-000000000010';
    w.k.startRun({
      actor: w.agent,
      at: T(1),
      run_id: runId,
      work_id: w.workId,
      equip_id: w.equipId,
      execution_refs: { device: 'local-worker-1' },
      expected_version: 0,
    });
    const run = w.k.projection.work_runs[runId];
    expect(run?.execution_refs).toEqual({ device: 'local-worker-1' });
    const rebuilt = w.k.rebuildProjection();
    expect(JSON.parse(JSON.stringify(rebuilt.work_runs[runId]))).toEqual(
      JSON.parse(JSON.stringify(run)),
    );
  });

  it('pausing captures checkpoint reason and position payloads', () => {
    const w = seeded();
    const runId = '0198b300-0000-7000-8000-000000000010';
    startRun(w, runId);
    w.k.transitionRun({
      actor: w.agent,
      at: T(2),
      run_id: runId,
      to: 'paused',
      reason: 'hold',
      expected_version: 0,
      run_revision: 1,
      checkpoint_reason: 'mid-flight pause',
      checkpoint_position: { step: 3 },
    });
    const cpId = w.k.projection.work_runs[runId]?.checkpoint_id ?? '';
    const cp = w.k.projection.checkpoints[cpId];
    expect(cp?.reason).toBe('mid-flight pause');
    expect(cp?.position).toEqual({ step: 3 });
    const rebuilt = w.k.rebuildProjection();
    expect(JSON.parse(JSON.stringify(rebuilt.checkpoints[cpId]))).toEqual(
      JSON.parse(JSON.stringify(cp)),
    );
  });

  it('stale equip is rejected with forbidden and no event', () => {
    const w = seeded();
    // boundary update bumps state version to 1, invalidating equips wholesale
    w.k.updateBoundary({
      actor: w.human,
      at: T(1),
      boundary: 'b2',
      reason: 'evolve',
      expected_version: 0,
    });
    const eventsBefore = w.k.events.length;
    const r = w.k.startRun({
      actor: w.agent,
      at: T(2),
      run_id: '0198b300-0000-7000-8000-000000000011',
      work_id: w.workId,
      equip_id: w.equipId,
      expected_version: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    expect(w.k.events.length).toBe(eventsBefore);
  });

  it('pausing the project blocks starting runs (equip issuance already blocked)', () => {
    const w = seeded();
    w.k.setProjectStatus({
      actor: w.human,
      at: T(1),
      to: 'paused',
      reason: 'pause',
      expected_version: 0,
    });
    const r = w.k.startRun({
      actor: w.agent,
      at: T(2),
      run_id: '0198b300-0000-7000-8000-000000000012',
      work_id: w.workId,
      equip_id: w.equipId,
      expected_version: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('project-not-active');
  });
});

describe('workrun: legal table + audit', () => {
  it('running→waiting_input→running requires input evidence', () => {
    const w = seeded();
    const runId = '0198b300-0000-7000-8000-000000000013';
    startRun(w, runId);
    expect(
      w.k.transitionRun({
        actor: w.agent,
        at: T(2),
        run_id: runId,
        to: 'waiting_input',
        reason: 'need specs',
        expected_version: 0,
        run_revision: 1,
      }).ok,
    ).toBe(true);
    const missing = w.k.transitionRun({
      actor: w.agent,
      at: T(3),
      run_id: runId,
      to: 'running',
      reason: 'resume',
      expected_version: 0,
      run_revision: 2,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('forbidden');
    const withEvidence = w.k.transitionRun({
      actor: w.agent,
      at: T(4),
      run_id: runId,
      to: 'running',
      reason: 'resume',
      expected_version: 0,
      run_revision: 2,
      input_provided: 'spec link',
    });
    expect(withEvidence.ok).toBe(true);
    expect(w.k.projection.work_runs[runId]?.run_revision).toBe(3);
  });

  it('waiting_approval→running requires a HUMAN approval result', () => {
    const w = seeded();
    const runId = '0198b300-0000-7000-8000-000000000014';
    startRun(w, runId);
    w.k.transitionRun({
      actor: w.agent,
      at: T(2),
      run_id: runId,
      to: 'waiting_approval',
      reason: 'ask',
      expected_version: 0,
      run_revision: 1,
    });
    const byAgent = w.k.transitionRun({
      actor: w.agent,
      at: T(3),
      run_id: runId,
      to: 'running',
      reason: 'self-approve',
      expected_version: 0,
      run_revision: 2,
      approval_result: 'yes',
    });
    expect(byAgent.ok).toBe(false);
    if (!byAgent.ok) expect(byAgent.error.code).toBe('forbidden');
    const byHuman = w.k.transitionRun({
      actor: w.human,
      at: T(4),
      run_id: runId,
      to: 'running',
      reason: 'approved',
      expected_version: 0,
      run_revision: 2,
      approval_result: 'yes',
    });
    expect(byHuman.ok).toBe(true);
  });

  it('terminal states have no exits: completed→running rejected with illegal-transition', () => {
    const w = seeded();
    const runId = '0198b300-0000-7000-8000-000000000015';
    startRun(w, runId);
    w.k.transitionRun({
      actor: w.agent,
      at: T(2),
      run_id: runId,
      to: 'completed',
      reason: 'done',
      expected_version: 0,
      run_revision: 1,
    });
    const r = w.k.transitionRun({
      actor: w.agent,
      at: T(3),
      run_id: runId,
      to: 'running',
      reason: 'undo',
      expected_version: 0,
      run_revision: 2,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('illegal-transition');
    expect(w.k.projection.work_runs[runId]?.status).toBe('completed');
  });

  it('cancelling→running is illegal; cancelling→cancelled drains', () => {
    const w = seeded();
    const runId = '0198b300-0000-7000-8000-000000000016';
    startRun(w, runId);
    w.k.transitionRun({
      actor: w.agent,
      at: T(2),
      run_id: runId,
      to: 'cancelling',
      reason: 'stop',
      expected_version: 0,
      run_revision: 1,
    });
    const undo = w.k.transitionRun({
      actor: w.agent,
      at: T(3),
      run_id: runId,
      to: 'running',
      reason: 'no',
      expected_version: 0,
      run_revision: 2,
    });
    expect(undo.ok).toBe(false);
    if (!undo.ok) expect(undo.error.code).toBe('illegal-transition');
    expect(
      w.k.transitionRun({
        actor: w.agent,
        at: T(4),
        run_id: runId,
        to: 'cancelled',
        reason: 'drain',
        expected_version: 0,
        run_revision: 2,
      }).ok,
    ).toBe(true);
  });

  it('empty reason rejected with rationale-required; stale revision rejected with version-conflict', () => {
    const w = seeded();
    const runId = '0198b300-0000-7000-8000-000000000017';
    startRun(w, runId);
    const noReason = w.k.transitionRun({
      actor: w.agent,
      at: T(2),
      run_id: runId,
      to: 'paused',
      reason: '  ',
      expected_version: 0,
      run_revision: 1,
    });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error.code).toBe('rationale-required');
    const stale = w.k.transitionRun({
      actor: w.agent,
      at: T(3),
      run_id: runId,
      to: 'paused',
      reason: 'r',
      expected_version: 0,
      run_revision: 0,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('version-conflict');
  });

  it('pausing records a checkpoint; resuming requires it; fresh run chains parent + attempt', () => {
    const w = seeded();
    const runId = '0198b300-0000-7000-8000-000000000018';
    startRun(w, runId);
    w.k.transitionRun({
      actor: w.agent,
      at: T(2),
      run_id: runId,
      to: 'paused',
      reason: 'hold on',
      expected_version: 0,
      run_revision: 1,
    });
    const row = w.k.projection.work_runs[runId];
    expect(row?.checkpoint_id).toBeDefined();
    const cpId = row?.checkpoint_id ?? '';
    expect(w.k.projection.checkpoints[cpId]?.state_version).toBe(0);
    // resume without checkpoint ref → forbidden
    const noRef = w.k.transitionRun({
      actor: w.agent,
      at: T(3),
      run_id: runId,
      to: 'running',
      reason: 'go',
      expected_version: 0,
      run_revision: 2,
    });
    expect(noRef.ok).toBe(false);
    if (!noRef.ok) expect(noRef.error.code).toBe('forbidden');
    // resume with ref → ok
    expect(
      w.k.transitionRun({
        actor: w.agent,
        at: T(4),
        run_id: runId,
        to: 'running',
        reason: 'go',
        expected_version: 0,
        run_revision: 2,
        resume_checkpoint_id: cpId,
      }).ok,
    ).toBe(true);
    // failed run → child run with attempt = 2
    w.k.transitionRun({
      actor: w.agent,
      at: T(5),
      run_id: runId,
      to: 'failed',
      reason: 'boom',
      expected_version: 0,
      run_revision: 3,
    });
    const childId = '0198b300-0000-7000-8000-000000000019';
    const child = w.k.startRun({
      actor: w.agent,
      at: T(6),
      run_id: childId,
      work_id: w.workId,
      equip_id: w.equipId,
      parent_run_id: runId,
      expected_version: 0,
    });
    expect(child.ok).toBe(true);
    expect(w.k.projection.work_runs[childId]?.attempt).toBe(2);
    expect(w.k.projection.work_runs[childId]?.parent_run_id).toBe(runId);
  });

  it('replay identity across the full run lifecycle', () => {
    const w = seeded();
    const runId = '0198b300-0000-7000-8000-00000000001a';
    startRun(w, runId);
    w.k.transitionRun({
      actor: w.agent,
      at: T(2),
      run_id: runId,
      to: 'waiting_input',
      reason: 'r',
      expected_version: 0,
      run_revision: 1,
    });
    w.k.transitionRun({
      actor: w.agent,
      at: T(3),
      run_id: runId,
      to: 'running',
      reason: 'r',
      expected_version: 0,
      run_revision: 2,
      input_provided: 'x',
    });
    w.k.transitionRun({
      actor: w.agent,
      at: T(4),
      run_id: runId,
      to: 'paused',
      reason: 'r',
      expected_version: 0,
      run_revision: 3,
    });
    const rebuilt = w.k.rebuildProjection();
    expect(JSON.parse(JSON.stringify(rebuilt.work_runs))).toEqual(
      JSON.parse(JSON.stringify(w.k.projection.work_runs)),
    );
  });
});
