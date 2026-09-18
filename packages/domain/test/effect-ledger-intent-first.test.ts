import { describe, expect, it } from 'vitest';

import { ProjectStateKernel } from '../src/index.js';
import type { EffectRow } from '../src/state/projection.js';

/*
 * Pins the Effect Ledger towards intent-first guarantees:
 * (1) intent recorded before the side effect runs,
 * (2) replaying the same intent key returns the same row with zero extra
 *     events,
 * (3) a late cancel folds to unknown without rollback and the row can
 *     never be closed afterwards.
 */

const T0 = '2026-09-18T00:00:00.000Z';
const HUMAN = '01900000-0000-7000-8000-000000000001';

function seed(): ProjectStateKernel {
  const k = new ProjectStateKernel();
  k.registerParticipant({ participant_id: HUMAN, type: 'human', at: T0 });
  k.createProject({ actor: HUMAN, at: T0, title: 'p', expected_version: 0 });
  return k;
}

function valueOf<T>(r: { ok: boolean; value?: T }): T {
  if (!r.ok) throw new Error('expected ok result');
  return (r as { ok: true; value: T }).value;
}

function countEvents(k: ProjectStateKernel, type: string): number {
  return k.events.filter((e) => e.type === type).length;
}

describe('intent-first ledger', () => {
  it('records the intent before the effect runs — new row state unknown', () => {
    const k = seed();
    const row = valueOf(
      k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'llm-call-proposal-001',
        expected_version: k.stateVersion,
      }),
    );
    expect(row.status).toBe('unknown');
    expect(row.intent_key).toBe('llm-call-proposal-001');
    expect(countEvents(k, 'effect.intent_recorded')).toBe(1);
  });

  it('replaying the same intent key returns the same row, zero extra events', () => {
    const k = seed();
    const first = valueOf(
      k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'same-intent',
        expected_version: k.stateVersion,
      }),
    );
    const second = valueOf(
      k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'same-intent',
        expected_version: k.stateVersion,
      }),
    );
    expect(second.id).toBe(first.id);
    expect(countEvents(k, 'effect.intent_recorded')).toBe(1);
    expect(
      Object.values(k.projection.effects).filter(
        (row: EffectRow) => row.intent_key === 'same-intent',
      ),
    ).toHaveLength(1);
  });

  it('two different intent keys create two rows', () => {
    const k = seed();
    valueOf(
      k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'a',
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'b',
        expected_version: k.stateVersion,
      }),
    );
    expect(countEvents(k, 'effect.intent_recorded')).toBe(2);
  });

  it('returns forbidden when the intent key was already closed on', () => {
    const k = seed();
    const row = valueOf(
      k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'closed-already',
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.closeEffect({
        actor: HUMAN,
        at: T0,
        effect_id: row.id,
        outcome: 'confirmed',
        expected_version: k.stateVersion,
      }),
    );
    const r = k.recordEffectIntent({
      actor: HUMAN,
      at: T0,
      intent_key: 'closed-already',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('forbidden');
    expect(r.error.details?.['reason']).toBe('intent-key-already-closed');
  });
});

describe('late cancel', () => {
  it('late cancel stamps late_cancel_received and keeps status unknown', () => {
    const k = seed();
    const row = valueOf(
      k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'will-be-cancelled',
        expected_version: k.stateVersion,
      }),
    );
    const cancelled = valueOf(
      k.cancelEffectLate({
        actor: HUMAN,
        at: T0,
        effect_id: row.id,
        reason: 'stakeholder veto',
        expected_version: k.stateVersion,
      }),
    );
    expect(cancelled.late_cancel_received).toBe(true);
    expect(cancelled.status).toBe('unknown');
    expect(countEvents(k, 'effect.cancel_recorded')).toBe(1);
  });

  it('closed late-cancel effect is refused', () => {
    const k = seed();
    const row = valueOf(
      k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'will-be-late-cancelled',
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.cancelEffectLate({
        actor: HUMAN,
        at: T0,
        effect_id: row.id,
        reason: 'r',
        expected_version: k.stateVersion,
      }),
    );
    const r = k.closeEffect({
      actor: HUMAN,
      at: T0,
      effect_id: row.id,
      outcome: 'confirmed',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('forbidden');
    expect(r.error.details?.['reason']).toBe('effect-cancelled');
    expect(countEvents(k, 'effect.closed')).toBe(0);
  });

  it('late cancel refuses on a closed effect', () => {
    const k = seed();
    const row = valueOf(
      k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'closed-then-late-cancel',
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.closeEffect({
        actor: HUMAN,
        at: T0,
        effect_id: row.id,
        outcome: 'confirmed',
        expected_version: k.stateVersion,
      }),
    );
    const r = k.cancelEffectLate({
      actor: HUMAN,
      at: T0,
      effect_id: row.id,
      reason: 'too late',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('forbidden');
    expect(r.error.details?.['reason']).toBe('effect-already-closed');
  });

  it('double late cancel is refused with late-cancel-already-recorded', () => {
    const k = seed();
    const row = valueOf(
      k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'double-cancel',
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.cancelEffectLate({
        actor: HUMAN,
        at: T0,
        effect_id: row.id,
        reason: 'first',
        expected_version: k.stateVersion,
      }),
    );
    const r = k.cancelEffectLate({
      actor: HUMAN,
      at: T0,
      effect_id: row.id,
      reason: 'second',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('forbidden');
    expect(r.error.details?.['reason']).toBe('late-cancel-already-recorded');
  });
});

describe('late cancel on a bare recordEffect row (backwards compatibility)', () => {
  it('marks unknown → late-cancelled; row is permanent rejectable', () => {
    const k = seed();
    const row = valueOf(
      k.recordEffect({
        actor: HUMAN,
        at: T0,
        description: 'deploy once',
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.cancelEffectLate({
        actor: HUMAN,
        at: T0,
        effect_id: row.id,
        reason: 'post-factum veto',
        expected_version: k.stateVersion,
      }),
    );
    const attempt = k.closeEffect({
      actor: HUMAN,
      at: T0,
      effect_id: row.id,
      outcome: 'confirmed',
      expected_version: k.stateVersion,
    });
    expect(attempt.ok).toBe(false);
    if (attempt.ok) throw new Error('unreachable');
    expect(attempt.error.details?.['reason']).toBe('effect-cancelled');
  });

  describe('boundary refusals', () => {
    it('cancelling a missing effect returns effect-not-found', () => {
      const k = seed();
      const r = k.cancelEffectLate({
        actor: HUMAN,
        at: T0,
        effect_id: '01900000-0000-7000-8000-ffffffffffff',
        reason: 'not there',
        expected_version: k.stateVersion,
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.error.details?.['reason']).toBe('effect-not-found');
    });

    it('recordEffectIntent refuses a stale expected_version', () => {
      const k = seed();
      const r = k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'x',
        expected_version: 999,
      });
      expect(r.ok).toBe(false);
    });
  });

  describe('intent-key dedupe note', () => {
    it('different projects see different ledgers (local scope)', () => {
      const k1 = seed();
      const k2 = seed();
      valueOf(
        k1.recordEffectIntent({
          actor: HUMAN,
          at: T0,
          intent_key: 'same-key',
          expected_version: k1.stateVersion,
        }),
      );
      const r = k2.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'same-key',
        expected_version: k2.stateVersion,
      });
      expect(r.ok).toBe(true);
    });
  });

  describe('backward compatibility with bare recordEffect/closeEffect', () => {
    it('existing flow still works verbatim (unknown → closed)', () => {
      const k = seed();
      const row = valueOf(
        k.recordEffect({ actor: HUMAN, at: T0, expected_version: k.stateVersion }),
      );
      expect(row.status).toBe('unknown');
      const cl = valueOf(
        k.closeEffect({
          actor: HUMAN,
          at: T0,
          effect_id: row.id,
          outcome: 'confirmed',
          expected_version: k.stateVersion,
        }),
      );
      expect(cl.status).toBe('confirmed');
    });
  });
});

describe('error paths on the new commands', () => {
  it('unknown actor on recordEffectIntent is forbidden', () => {
    const k = seed();
    const r = k.recordEffectIntent({
      actor: 'nobody',
      at: T0,
      intent_key: 'k',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.details?.['reason']).toBe('unknown-actor');
  });

  it('empty intent_key is rejected by schema', () => {
    const k = seed();
    const r = k.recordEffectIntent({
      actor: HUMAN,
      at: T0,
      intent_key: '',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('forbidden');
    expect(r.error.details?.['reason']).toBe('invalid-fields');
  });

  it('unknown actor on cancelEffectLate is forbidden', () => {
    const k = seed();
    const row = valueOf(
      k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'y',
        expected_version: k.stateVersion,
      }),
    );
    const r = k.cancelEffectLate({
      actor: 'nobody',
      at: T0,
      effect_id: row.id,
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.details?.['reason']).toBe('unknown-actor');
  });

  it('cancelEffectLate rejects a malformed effect_id via schema', () => {
    const k = seed();
    const r = k.cancelEffectLate({
      actor: HUMAN,
      at: T0,
      effect_id: 'not-a-uuid',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.details?.['reason']).toBe('invalid-fields');
  });

  it('cancelEffectLate refuses a version mismatch', () => {
    const k = seed();
    const row = valueOf(
      k.recordEffectIntent({
        actor: HUMAN,
        at: T0,
        intent_key: 'v',
        expected_version: k.stateVersion,
      }),
    );
    const r = k.cancelEffectLate({
      actor: HUMAN,
      at: T0,
      effect_id: row.id,
      expected_version: k.stateVersion + 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('version-conflict');
  });
});

describe('kernel coverage pins', () => {
  it('startRun on a terminal parent_reprise advances the attempt counter', () => {
    const k = seed();
    const agent = '01900000-0000-7000-8000-000000000002';
    k.registerParticipant({ participant_id: agent, type: 'agent', at: T0 });
    const work = valueOf(
      k.createWork({
        actor: HUMAN,
        at: T0,
        title: 'retry-flow',
        reason: 'r',
        expected_version: k.stateVersion,
      }),
    );
    const equip = valueOf(
      k.issueEquip({ actor: agent, at: T0, work_id: work.id, expected_version: k.stateVersion }),
    );
    const parent = valueOf(
      k.startRun({
        actor: agent,
        at: T0,
        run_id: '01900000-0000-7000-8000-000000000010',
        work_id: work.id,
        equip_id: equip.id,
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.transitionRun({
        actor: HUMAN,
        at: T0,
        run_id: parent.id,
        to: 'failed',
        reason: 'r',
        run_revision: parent.run_revision,
        expected_version: k.stateVersion,
      }),
    );
    const retry = valueOf(
      k.startRun({
        actor: agent,
        at: T0,
        run_id: '01900000-0000-7000-8000-000000000011',
        work_id: work.id,
        equip_id: equip.id,
        parent_run_id: parent.id,
        expected_version: k.stateVersion,
      }),
    );
    expect(retry.attempt).toBe(2);
  });

  it('openIntervention version-conflict fires the pushed-down row', () => {
    const k = seed();
    const agent = '01900000-0000-7000-8000-000000000002';
    k.registerParticipant({ participant_id: agent, type: 'agent', at: T0 });
    const work = valueOf(
      k.createWork({
        actor: HUMAN,
        at: T0,
        title: 'v',
        reason: 'r',
        expected_version: k.stateVersion,
      }),
    );
    const equip = valueOf(
      k.issueEquip({ actor: agent, at: T0, work_id: work.id, expected_version: 0 }),
    );
    const run = valueOf(
      k.startRun({
        actor: agent,
        at: T0,
        run_id: '01900000-0000-7000-8000-000000000020',
        work_id: work.id,
        equip_id: equip.id,
        expected_version: k.stateVersion,
      }),
    );
    const r = k.openIntervention({
      actor: HUMAN,
      at: T0,
      run_id: run.id,
      session_id: 'session-a',
      mode: 'observe',
      run_revision: run.run_revision,
      expected_version: 999,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('version-conflict');
  });

  it('closeIntervention version-conflict fires the pulled-down row', () => {
    const k = seed();
    const agent = '01900000-0000-7000-8000-000000000002';
    k.registerParticipant({ participant_id: agent, type: 'agent', at: T0 });
    const work = valueOf(
      k.createWork({
        actor: HUMAN,
        at: T0,
        title: 'v',
        reason: 'r',
        expected_version: k.stateVersion,
      }),
    );
    const equip = valueOf(
      k.issueEquip({ actor: agent, at: T0, work_id: work.id, expected_version: 0 }),
    );
    const run = valueOf(
      k.startRun({
        actor: agent,
        at: T0,
        run_id: '01900000-0000-7000-8000-000000000021',
        work_id: work.id,
        equip_id: equip.id,
        expected_version: k.stateVersion,
      }),
    );
    k.openIntervention({
      actor: HUMAN,
      at: T0,
      run_id: run.id,
      session_id: 'session-b',
      mode: 'observe',
      run_revision: run.run_revision,
      expected_version: k.stateVersion,
    });
    const r = k.closeIntervention({
      actor: HUMAN,
      at: T0,
      run_id: run.id,
      session_id: 'session-b',
      run_revision: 0,
      expected_version: 999,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('version-conflict');
  });
});
