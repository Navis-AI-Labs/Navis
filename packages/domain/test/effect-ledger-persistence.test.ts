import { describe, expect, it } from 'vitest';

import { ProjectStateKernel } from '../src/index.js';

/*
 * Regression pins for change effect-ledger-persistence: the pending
 * recovery predicate lists exactly the intent rows that still need
 * closure, and a replay produces the same list from a kernel rebuilt
 * from events alone.
 */

const T0 = '2026-09-18T00:00:00.000Z';
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

function intent(k: ProjectStateKernel, key: string): string {
  return valueOf(
    k.recordEffectIntent({
      actor: HUMAN,
      at: T0,
      intent_key: key,
      expected_version: k.stateVersion,
    }),
  ).id;
}

describe('listPendingEffects', () => {
  it('returns the intent rows that are alive and still unknown', () => {
    const k = seed();
    const a = intent(k, 'a');
    const b = intent(k, 'b');

    expect(
      k
        .listPendingEffects()
        .map((e) => e.id)
        .sort(),
    ).toEqual([a, b].sort());
  });

  it('confirmed effects are dropped from the pending list', () => {
    const k = seed();
    const a = intent(k, 'a');
    valueOf(
      k.closeEffect({
        actor: HUMAN,
        at: T0,
        effect_id: a,
        outcome: 'confirmed',
        expected_version: k.stateVersion,
      }),
    );
    expect(k.listPendingEffects().map((e) => e.id)).toEqual([]);
  });

  it('failed effects are also dropped (not pending)', () => {
    const k = seed();
    const a = intent(k, 'a');
    valueOf(
      k.closeEffect({
        actor: HUMAN,
        at: T0,
        effect_id: a,
        outcome: 'failed',
        expected_version: k.stateVersion,
      }),
    );
    expect(k.listPendingEffects()).toHaveLength(0);
  });

  it('late-cancelled effects stay pending even though confirm is refused', () => {
    const k = seed();
    const a = intent(k, 'a');
    valueOf(
      k.cancelEffectLate({
        actor: HUMAN,
        at: T0,
        effect_id: a,
        reason: 'stakeholder veto',
        expected_version: k.stateVersion,
      }),
    );
    expect(k.listPendingEffects()).toHaveLength(1);
    expect(k.listPendingEffects()[0]?.late_cancel_received).toBe(true);
  });

  it('replay from event log returns the identical pending list', () => {
    const k = seed();
    const a = intent(k, 'a');
    const b = intent(k, 'b');
    valueOf(
      k.closeEffect({
        actor: HUMAN,
        at: T0,
        effect_id: a,
        outcome: 'confirmed',
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.cancelEffectLate({
        actor: HUMAN,
        at: T0,
        effect_id: b,
        reason: 'x',
        expected_version: k.stateVersion,
      }),
    );

    const rebuilt = ProjectStateKernel.fromEvents(k.events);
    expect(rebuilt.listPendingEffects().map((e) => e.id)).toEqual(
      k
        .listPendingEffects()
        .map((e) => e.id)
        .slice(0),
    );
  });

  it('a fresh kernel lists every unknown intent as pending', () => {
    const k = seed();
    expect(k.listPendingEffects()).toHaveLength(0);
    intent(k, 'first');
    intent(k, 'second');
    expect(k.listPendingEffects()).toHaveLength(2);
  });
});
