import { describe, expect, it } from 'vitest';

import { ProjectStateKernel } from '../src/index.js';

/*
 * Regression pins for change work-lifecycle-closure:
 * 1. equip.active_holds narrows to the work (project-wide holds still in);
 * 2. closed works (cancelled/completed) cannot start a run, even with a
 *    perfectly valid equip.
 */

const T0 = '2026-09-17T00:00:00.000Z';
const HUMAN = '01900000-0000-7000-8000-000000000001';
const AGENT = '01900000-0000-7000-8000-000000000002';

function seed(): ProjectStateKernel {
  const k = new ProjectStateKernel();
  k.registerParticipant({ participant_id: HUMAN, type: 'human', at: T0 });
  k.registerParticipant({ participant_id: AGENT, type: 'agent', at: T0 });
  k.createProject({ actor: HUMAN, at: T0, title: 'p', expected_version: 0 });
  return k;
}

function valueOf<T>(r: { ok: boolean; value?: T }): T {
  if (!r.ok) throw new Error('expected ok result');
  return (r as { ok: true; value: T }).value;
}

function createWork(k: ProjectStateKernel, title: string): string {
  return valueOf(
    k.createWork({ actor: HUMAN, at: T0, reason: 'r', title, expected_version: k.stateVersion }),
  ).id;
}

function registerHold(k: ProjectStateKernel, workId?: string): string {
  return valueOf(
    k.registerHold({
      actor: HUMAN,
      at: T0,
      kind: 'deferred_decision',
      severity: 'medium',
      statement: 'blocking note',
      ...(workId === undefined ? {} : { registered_during_work: workId }),
      expected_version: k.stateVersion,
    }),
  ).id;
}

describe('equip active_holds narrows to the work', () => {
  it('work-bound equip carries its own holds plus project-wide holds only', () => {
    const k = seed();
    const w1 = createWork(k, 'W1');
    const w2 = createWork(k, 'W2');
    const h11 = registerHold(k, w1);
    const h12 = registerHold(k, w1);
    const h2 = registerHold(k, w2);
    const hGlobal = registerHold(k); // no work attribution → project-wide

    const equipW1 = valueOf(
      k.issueEquip({ actor: AGENT, at: T0, work_id: w1, expected_version: k.stateVersion }),
    );
    expect([...equipW1.active_holds].sort()).toEqual([h11, h12, hGlobal].sort());

    const equipW2 = valueOf(
      k.issueEquip({ actor: AGENT, at: T0, work_id: w2, expected_version: k.stateVersion }),
    );
    expect([...equipW2.active_holds].sort()).toEqual([h2, hGlobal].sort());

    // verified_facts stays project-wide regardless of work narrowing
    expect(equipW1.verified_facts).toEqual(equipW2.verified_facts);
  });

  it('project-wide hold does NOT disappear when only work-bound holds are at play', () => {
    const k = seed();
    const w1 = createWork(k, 'W1');
    registerHold(k, w1);
    const hGlobal = registerHold(k);

    const equip = valueOf(
      k.issueEquip({ actor: AGENT, at: T0, work_id: w1, expected_version: k.stateVersion }),
    );
    expect(equip.active_holds).toContain(hGlobal);
  });

  it('a hold with unknown-to-this-work attribution does NOT leak in', () => {
    const k = seed();
    const w1 = createWork(k, 'W1');
    const otherWorkHold = registerHold(k, createWork(k, 'other'));
    const equip = valueOf(
      k.issueEquip({ actor: AGENT, at: T0, work_id: w1, expected_version: k.stateVersion }),
    );
    expect(equip.active_holds).not.toContain(otherWorkHold);
  });
});

describe('closed-work start guard', () => {
  function setupWorkAndEquip(k: ProjectStateKernel) {
    const w = createWork(k, 'some work');
    const equip = valueOf(
      k.issueEquip({ actor: AGENT, at: T0, work_id: w, expected_version: k.stateVersion }),
    );
    return { w, equip };
  }

  it('cancelled work cannot start a run even with a current equip', () => {
    const k = seed();
    const { w, equip } = setupWorkAndEquip(k);

    valueOf(
      k.cancelWork({
        actor: HUMAN,
        at: T0,
        reason: 'closed',
        work_id: w,
        expected_version: k.stateVersion,
      }),
    );

    const r = k.startRun({
      actor: AGENT,
      at: T0,
      run_id: '01900000-0000-7000-8000-0000000000ff',
      work_id: w,
      equip_id: equip.id,
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('forbidden');
    expect(r.error.details?.['reason']).toBe('work-closed');
    expect(k.events.filter((e) => e.type === 'workrun.started')).toHaveLength(0);
  });

  it('completed work cannot start a run either (rebuild-path pin)', () => {
    const k = seed();
    const w = createWork(k, 'soon-completed');
    // No public command moves a work to 'completed'; the status space
    // still admits it, so rebuild path must carry the guard. Inject the
    // completion directly via the same status_change event archive uses.
    const last = k.events[k.events.length - 1];
    if (last === undefined) throw new Error('seed kernel must have events');
    const k2 = ProjectStateKernel.fromEvents([
      ...k.events,
      {
        ...last,
        seq: k.currentSeq + 1,
        type: 'work.status_changed',
        actor: HUMAN,
        data: { work_id: w, from: 'planned', to: 'completed', reason: 'x' },
      },
    ]);
    expect(k2.projection.works[w]?.status).toBe('completed');

    const equip = valueOf(
      k2.issueEquip({ actor: AGENT, at: T0, expected_version: k2.stateVersion }),
    );
    const r = k2.startRun({
      actor: AGENT,
      at: T0,
      run_id: '01900000-0000-7000-8000-0000000000fd',
      work_id: w,
      equip_id: equip.id,
      expected_version: k2.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('forbidden');
    expect(r.error.details?.['reason']).toBe('work-closed');
  });
});
