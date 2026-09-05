import { describe, expect, it } from 'vitest';

import { ProjectStateKernel } from '../src/state/project-state-kernel.js';

/**
 * Intervention session ledger behavior: parallel observe/assist, takeover
 * exclusivity and presence, revision and expected-version races on session
 * commands, the consent lifecycle, close authority, and the fresh-equip
 * resumption gate armed by a takeover release.
 */

const AT = '2026-09-03T10:00:00.000Z';
const T = (m: number) => new Date(Date.parse(AT) + m * 60_000).toISOString();

interface World {
  k: ProjectStateKernel;
  human: string;
  human2: string;
  agent: string;
  agent2: string;
  workId: string;
  equipId: string;
  runId: string;
}

function seeded(): World {
  const k = new ProjectStateKernel();
  const human = '0198b100-0000-7000-8000-000000000001';
  const human2 = '0198b100-0000-7000-8000-000000000003';
  const agent = '0198b100-0000-7000-8000-000000000002';
  const agent2 = '0198b100-0000-7000-8000-000000000004';
  for (const [id, type] of [
    [human, 'human'],
    [agent, 'agent'],
    [human2, 'human'],
    [agent2, 'agent'],
  ] as const) {
    k.registerParticipant({ participant_id: id, type, at: AT });
  }
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
  const runId = '0198b400-0000-7000-8000-000000000001';
  const started = k.startRun({
    actor: agent,
    at: T(1),
    run_id: runId,
    work_id: work.value.id,
    equip_id: equip.value.id,
    expected_version: 0,
  });
  if (!started.ok) throw new Error('seed startRun failed');
  return { k, human, human2, agent, agent2, workId: work.value.id, equipId: equip.value.id, runId };
}

/** The run's current revision — every run event (sessions included) bumps it by exactly 1. */
function rev(w: World): number {
  return w.k.projection.work_runs[w.runId]?.run_revision ?? 0;
}

function open(
  w: World,
  actor: string,
  sessionId: string,
  mode: 'observe' | 'assist' | 'takeover',
  at = T(2),
): boolean {
  return w.k.openIntervention({
    actor,
    at,
    run_id: w.runId,
    session_id: sessionId,
    mode,
    expected_version: 0,
    run_revision: rev(w),
  }).ok;
}

function close(
  w: World,
  actor: string,
  sessionId: string,
  at: number,
  consent?: 'granted' | 'denied',
): boolean {
  return w.k.closeIntervention({
    actor,
    at: T(at),
    run_id: w.runId,
    session_id: sessionId,
    ...(consent === undefined ? {} : { consent_status: consent }),
    expected_version: 0,
    run_revision: rev(w),
  }).ok;
}

describe('intervention: multi-read-one-write', () => {
  it('parallel observers and assistants coexist (five sessions)', () => {
    const w = seeded();
    expect(open(w, w.agent2, 's1', 'observe')).toBe(true);
    expect(open(w, w.human2, 's2', 'observe')).toBe(true);
    expect(open(w, w.human, 's3', 'observe')).toBe(true);
    expect(open(w, w.human2, 's4', 'assist')).toBe(true);
    expect(open(w, w.human, 's5', 'assist')).toBe(true);
    const run = w.k.projection.work_runs[w.runId];
    expect(run?.intervention_sessions).toHaveLength(5);
    expect(run?.intervention_sessions.every((x) => x.ended_at === undefined)).toBe(true);
    expect(run?.intervention_mode).toBe('assist'); // strongest active mode
    // every session event bumped the run revision: start (1) + five opens (6)
    expect(run?.run_revision).toBe(6);
    // assist sessions record pending consent
    expect(run?.intervention_sessions.find((x) => x.session_id === 's4')?.consent_status).toBe(
      'pending',
    );
    expect(
      run?.intervention_sessions.find((x) => x.session_id === 's1')?.consent_status,
    ).toBeUndefined();
  });

  it('double takeover is rejected', () => {
    const w = seeded();
    expect(open(w, w.human, 'o0', 'observe')).toBe(true); // presence first
    expect(open(w, w.human, 't1', 'takeover')).toBe(true);
    const eventsBefore = w.k.events.length;
    const second = open(w, w.human2, 't2', 'takeover');
    expect(second).toBe(false);
    expect(w.k.events.length).toBe(eventsBefore);
    expect(rev(w)).toBe(3); // rejected commands append nothing
  });

  it('takeover without prior presence is rejected; after observing it succeeds', () => {
    const w = seeded();
    const ghost = open(w, w.human2, 't3', 'takeover');
    expect(ghost).toBe(false);
    expect(open(w, w.human2, 'o1', 'observe')).toBe(true);
    expect(open(w, w.human2, 't4', 'takeover')).toBe(true);
  });

  it('stale expected run_revision is rejected with version-conflict on both commands', () => {
    const w = seeded();
    const staleOpen = w.k.openIntervention({
      actor: w.agent2,
      at: T(2),
      run_id: w.runId,
      session_id: 'sv1',
      mode: 'observe',
      expected_version: 0,
      run_revision: 0,
    });
    expect(staleOpen.ok).toBe(false);
    if (!staleOpen.ok) expect(staleOpen.error.code).toBe('version-conflict');
    expect(open(w, w.agent2, 'sv2', 'observe')).toBe(true);
    const staleClose = w.k.closeIntervention({
      actor: w.agent2,
      at: T(3),
      run_id: w.runId,
      session_id: 'sv2',
      expected_version: 0,
      run_revision: 1,
    });
    expect(staleClose.ok).toBe(false);
    if (!staleClose.ok) expect(staleClose.error.code).toBe('version-conflict');
    expect(rev(w)).toBe(2);
  });
});

describe('intervention: consent lifecycle (pending on open, terminal on close)', () => {
  it('an assist session closes with terminal granted consent', () => {
    const w = seeded();
    expect(open(w, w.agent, 'cs1', 'assist')).toBe(true);
    expect(close(w, w.agent, 'cs1', 3, 'granted')).toBe(true);
    const s = w.k.projection.work_runs[w.runId]?.intervention_sessions.find(
      (x) => x.session_id === 'cs1',
    );
    expect(s?.ended_at).toBe(T(3));
    expect(s?.consent_status).toBe('granted');
  });

  it('an assist session closes with terminal denied consent', () => {
    const w = seeded();
    expect(open(w, w.agent, 'cs2', 'assist')).toBe(true);
    expect(close(w, w.human, 'cs2', 3, 'denied')).toBe(true); // human may close any
    const s = w.k.projection.work_runs[w.runId]?.intervention_sessions.find(
      (x) => x.session_id === 'cs2',
    );
    expect(s?.consent_status).toBe('denied');
  });

  it('closing an assist session without terminal consent is rejected (consent-required)', () => {
    const w = seeded();
    expect(open(w, w.agent, 'cs3', 'assist')).toBe(true);
    const missing = w.k.closeIntervention({
      actor: w.agent,
      at: T(3),
      run_id: w.runId,
      session_id: 'cs3',
      expected_version: 0,
      run_revision: rev(w),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.details).toMatchObject({ reason: 'consent-required' });
    expect(
      w.k.projection.work_runs[w.runId]?.intervention_sessions.find((x) => x.session_id === 'cs3')
        ?.ended_at,
    ).toBeUndefined();
  });

  it('observe sessions carry no consent: supplying one is rejected, omitting one closes', () => {
    const w = seeded();
    expect(open(w, w.agent, 'cs4', 'observe')).toBe(true);
    const withConsent = w.k.closeIntervention({
      actor: w.agent,
      at: T(3),
      run_id: w.runId,
      session_id: 'cs4',
      consent_status: 'granted',
      expected_version: 0,
      run_revision: rev(w),
    });
    expect(withConsent.ok).toBe(false);
    if (!withConsent.ok) {
      expect(withConsent.error.details).toMatchObject({ reason: 'consent-not-applicable' });
    }
    expect(close(w, w.agent, 'cs4', 4)).toBe(true);
    const s = w.k.projection.work_runs[w.runId]?.intervention_sessions.find(
      (x) => x.session_id === 'cs4',
    );
    expect(s?.ended_at).toBe(T(4));
    expect(s?.consent_status).toBeUndefined();
  });

  it('an active takeover close records terminal consent and sets the release flag', () => {
    const w = seeded();
    expect(open(w, w.human, 'cs5o', 'observe')).toBe(true);
    expect(open(w, w.human, 'cs5t', 'takeover')).toBe(true);
    expect(close(w, w.human, 'cs5t', 3, 'granted')).toBe(true);
    const s = w.k.projection.work_runs[w.runId]?.intervention_sessions.find(
      (x) => x.session_id === 'cs5t',
    );
    expect(s?.consent_status).toBe('granted');
    expect(w.k.projection.work_runs[w.runId]?.re_equip_required).toBe(true);
  });
});

describe('intervention: close authority + re-equip gate', () => {
  it('agent cannot close another participant session; human may close any; owner may close own', () => {
    const w = seeded();
    expect(open(w, w.human, 'c1', 'assist')).toBe(true);
    // agent (not owner, not human) → rejected
    const byAgent = w.k.closeIntervention({
      actor: w.agent,
      at: T(3),
      run_id: w.runId,
      session_id: 'c1',
      consent_status: 'granted',
      expected_version: 0,
      run_revision: rev(w),
    });
    expect(byAgent.ok).toBe(false);
    if (!byAgent.ok) expect(byAgent.error.code).toBe('forbidden');
    // human2 (not owner, but human) → allowed
    expect(close(w, w.human2, 'c1', 4, 'granted')).toBe(true);
    // owner may close own
    expect(open(w, w.human, 'c2', 'assist')).toBe(true);
    expect(close(w, w.human, 'c2', 5, 'granted')).toBe(true);
  });

  it('closing a takeover session sets re_equip_required; continuing on old equip is rejected; fresh equip resumes', () => {
    const w = seeded();
    // takeover holder must first be present
    expect(open(w, w.human, 'o2', 'observe')).toBe(true);
    expect(open(w, w.human, 't5', 'takeover')).toBe(true);
    // pause the run while takeover active (revision: start 1 + two opens = 3)
    expect(
      w.k.transitionRun({
        actor: w.agent,
        at: T(3),
        run_id: w.runId,
        to: 'paused',
        reason: 'handover',
        expected_version: 0,
        run_revision: rev(w),
      }).ok,
    ).toBe(true);
    // release the takeover (holder self-release; terminal consent recorded)
    expect(close(w, w.human, 't5', 4, 'granted')).toBe(true);
    expect(w.k.projection.work_runs[w.runId]?.re_equip_required).toBe(true);
    // resuming on the pre-takeover equip (none presented) → forbidden
    const onOld = w.k.transitionRun({
      actor: w.agent,
      at: T(5),
      run_id: w.runId,
      to: 'running',
      reason: 'resume',
      expected_version: 0,
      run_revision: rev(w),
      resume_checkpoint_id: w.k.projection.work_runs[w.runId]?.checkpoint_id ?? '',
    });
    expect(onOld.ok).toBe(false);
    if (!onOld.ok) expect(onOld.error.code).toBe('forbidden');
    // referencing the equip issued before the takeover (still active and version-current)
    // is rejected too: the gate requires an equip issued after the release
    const onPreTakeover = w.k.transitionRun({
      actor: w.agent,
      at: T(5),
      run_id: w.runId,
      to: 'running',
      reason: 'resume',
      expected_version: 0,
      run_revision: rev(w),
      resume_checkpoint_id: w.k.projection.work_runs[w.runId]?.checkpoint_id ?? '',
      equip_id: w.equipId,
    });
    expect(onPreTakeover.ok).toBe(false);
    if (!onPreTakeover.ok) {
      expect(onPreTakeover.error.details).toMatchObject({ reason: 'stale-equip' });
    }
    // a foreign equip issued at the current version to someone else is rejected too
    const foreign = w.k.issueEquip({
      actor: w.human,
      at: T(6),
      participant_id: w.agent2,
      expected_version: 0,
    });
    if (!foreign.ok) throw new Error('foreign equip failed');
    const onForeign = w.k.transitionRun({
      actor: w.agent,
      at: T(6),
      run_id: w.runId,
      to: 'running',
      reason: 'resume',
      expected_version: 0,
      run_revision: rev(w),
      resume_checkpoint_id: w.k.projection.work_runs[w.runId]?.checkpoint_id ?? '',
      equip_id: foreign.value.id,
    });
    expect(onForeign.ok).toBe(false);
    if (!onForeign.ok) expect(onForeign.error.details).toMatchObject({ reason: 'foreign-equip' });
    // present a fresh equip issued at the current version to the actor → resumes and clears the flag
    const fresh = w.k.issueEquip({
      actor: w.human,
      at: T(6),
      participant_id: w.agent,
      expected_version: 0,
    });
    if (!fresh.ok) throw new Error('fresh equip failed');
    const resumed = w.k.transitionRun({
      actor: w.agent,
      at: T(7),
      run_id: w.runId,
      to: 'running',
      reason: 'resume',
      expected_version: 0,
      run_revision: rev(w),
      resume_checkpoint_id: w.k.projection.work_runs[w.runId]?.checkpoint_id ?? '',
      equip_id: fresh.value.id,
    });
    expect(resumed.ok).toBe(true);
    expect(w.k.projection.work_runs[w.runId]?.re_equip_required).toBe(false);
  });

  it('a boundary update after the release marks the pre-takeover equip stale outright', () => {
    const w = seeded();
    expect(open(w, w.human, 'b0', 'observe')).toBe(true);
    expect(open(w, w.human, 'b1', 'takeover')).toBe(true);
    expect(
      w.k.transitionRun({
        actor: w.agent,
        at: T(3),
        run_id: w.runId,
        to: 'paused',
        reason: 'handover',
        expected_version: 0,
        run_revision: rev(w),
      }).ok,
    ).toBe(true);
    expect(close(w, w.human, 'b1', 4, 'granted')).toBe(true);
    // the boundary update marks the pre-takeover equip stale (state_version drift)
    w.k.updateBoundary({
      actor: w.human,
      at: T(5),
      boundary: 'b2',
      reason: 'evolve',
      expected_version: 0,
    });
    const resumed = w.k.transitionRun({
      actor: w.agent,
      at: T(6),
      run_id: w.runId,
      to: 'running',
      reason: 'resume',
      expected_version: 1,
      run_revision: rev(w),
      resume_checkpoint_id: w.k.projection.work_runs[w.runId]?.checkpoint_id ?? '',
      equip_id: w.equipId,
    });
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) expect(resumed.error.details).toMatchObject({ reason: 'stale-equip' });
  });

  it('replay identity across sessions, takeover, release, and re-equip', () => {
    const w = seeded();
    open(w, w.agent2, 'r1', 'observe');
    expect(open(w, w.human, 'r0', 'observe')).toBe(true); // presence precedes takeover
    expect(open(w, w.human, 'r2', 'takeover')).toBe(true);
    w.k.transitionRun({
      actor: w.agent,
      at: T(3),
      run_id: w.runId,
      to: 'paused',
      reason: 'r',
      expected_version: 0,
      run_revision: rev(w),
    });
    expect(close(w, w.human, 'r2', 4, 'denied')).toBe(true);
    const rebuilt = w.k.rebuildProjection();
    expect(JSON.parse(JSON.stringify(rebuilt.work_runs))).toEqual(
      JSON.parse(JSON.stringify(w.k.projection.work_runs)),
    );
  });
});
