import { describe, expect, it } from 'vitest';

import { ProjectStateKernel, uuidv7 } from '../src/index.js';

/*
 * Regression pin for change effect-execution-recovery (R0-48 analogue):
 * life-cycle now has a real 'executing' state; closeEffect refuses
 * unknown (not-attempted) rows, refuse second begin, and supports an
 * auditable reset path. replay(fromEvents) yields identical answers.
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

describe('malformed inputs', () => {
  it('begin with bogus effect_id and at fields is forbidden as invalid-fields', () => {
    const k = seed();
    const r = k.beginEffectExecution({
      actor: HUMAN,
      at: 'not-a-time',
      effect_id: 'not-a-uuid',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['reason']).toBe('invalid-fields');
  });

  it('begin refuses unknown actor', () => {
    const k = seed();
    const r = k.beginEffectExecution({
      actor: 'nobody',
      at: T0,
      effect_id: uuidv7(),
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['reason']).toBe('unknown-actor');
  });

  it('reset refuses unknown actor', () => {
    const k = seed();
    const r = k.resetEffectExecution({
      actor: 'nobody',
      at: T0,
      effect_id: uuidv7(),
      reason: 'actor fake',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['reason']).toBe('unknown-actor');
  });

  it('beginEffectExecution with bad uuid effect_id is invalid-fields', () => {
    const k = seed();
    const r = k.beginEffectExecution({
      actor: HUMAN,
      at: T0,
      effect_id: 'bad-uuid',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['reason']).toBe('invalid-fields');
  });

  it('reset with empty reason is forbidden as invalid-fields', () => {
    const k = seed();
    const r = k.resetEffectExecution({
      actor: HUMAN,
      at: T0,
      effect_id: uuidv7(),
      reason: '',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['reason']).toBe('invalid-fields');
  });
});

describe('begin execution', () => {
  it('transitions unknown → executing exactly once', () => {
    const k = seed();
    const id = intent(k, 'a');
    const begun = valueOf(
      k.beginEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        expected_version: k.stateVersion,
      }),
    );
    expect(begun.status).toBe('executing');

    const twice = k.beginEffectExecution({
      actor: HUMAN,
      at: T0,
      effect_id: id,
      expected_version: k.stateVersion,
    });
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error.details?.['reason']).toBe('effect-not-unknown');
  });

  it('unknown effect_id refuses begin', () => {
    const k = seed();
    const r = k.beginEffectExecution({
      actor: HUMAN,
      at: T0,
      effect_id: uuidv7(),
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['reason']).toBe('effect-not-found');
  });

  it('close without begin is refused as not-executing', () => {
    const k = seed();
    const id = intent(k, 'b');
    const r = k.closeEffect({
      actor: HUMAN,
      at: T0,
      effect_id: id,
      outcome: 'confirmed',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['reason']).toBe('effect-not-executing');
    expect(k.listPendingEffects()).toHaveLength(1);
  });
});

it('reset on missing effect is effect-not-found', () => {
  const k = seed();
  const r = k.resetEffectExecution({
    actor: HUMAN,
    at: T0,
    effect_id: uuidv7(),
    reason: 'shopping',
    expected_version: k.stateVersion,
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.details?.['reason']).toBe('effect-not-found');
});
describe('executing → terminal', () => {
  it('close from executing moves to confirmed', () => {
    const k = seed();
    const id = intent(k, 'c');
    valueOf(
      k.beginEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        expected_version: k.stateVersion,
      }),
    );
    const closed = valueOf(
      k.closeEffect({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        outcome: 'confirmed',
        expected_version: k.stateVersion,
      }),
    );
    expect(closed.status).toBe('confirmed');
    expect(k.listExecutingEffects()).toHaveLength(0);
  });

  it('double-close is refused as already-closed', () => {
    const k = seed();
    const id = intent(k, 'd');
    valueOf(
      k.beginEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.closeEffect({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        outcome: 'failed',
        expected_version: k.stateVersion,
      }),
    );
    const again = k.closeEffect({
      actor: HUMAN,
      at: T0,
      effect_id: id,
      outcome: 'failed',
      expected_version: k.stateVersion,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.details?.['reason']).toBe('effect-already-closed');
  });
});

describe('rocket recovery via resetEffectExecution', () => {
  it('executing → unknown; attempts counter grows monotonically', () => {
    const k = seed();
    const id = intent(k, 'e');
    valueOf(
      k.beginEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        expected_version: k.stateVersion,
      }),
    );

    const r1 = valueOf(
      k.resetEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        reason: 'process restarted without checkpoint',
        expected_version: k.stateVersion,
      }),
    );
    expect(r1.status).toBe('unknown');
    expect(r1.execution_attempts).toBe(1);

    // Second reset refuses — status is now unknown.
    const r2 = k.resetEffectExecution({
      actor: HUMAN,
      at: T0,
      effect_id: id,
      reason: 'again',
      expected_version: k.stateVersion,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.details?.['reason']).toBe('effect-not-executing');
  });

  it('reset is forbidden unless currently executing', () => {
    const k = seed();
    const id = intent(k, 'f');
    const r = k.resetEffectExecution({
      actor: HUMAN,
      at: T0,
      effect_id: id,
      reason: 'no',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['reason']).toBe('effect-not-executing');
  });

  it('begin-after-reset is fine and triple-monotone', () => {
    const k = seed();
    const id = intent(k, 'g');
    valueOf(
      k.beginEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.resetEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        reason: 'aurora',
        expected_version: k.stateVersion,
      }),
    );
    const rebegun = valueOf(
      k.beginEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        expected_version: k.stateVersion,
      }),
    );
    expect(rebegun.status).toBe('executing');
    // attempts record survives a new begin
    expect(rebegun.execution_attempts).toBe(1);
  });
});

describe('recovery sweep after crash', () => {
  it('two intents, one crashed in executing → listExecutingEffects returns exactly that row', () => {
    const k = seed();
    const done = intent(k, 'done');
    const stuck = intent(k, 'stuck');
    valueOf(
      k.beginEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: done,
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.closeEffect({
        actor: HUMAN,
        at: T0,
        effect_id: done,
        outcome: 'confirmed',
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.beginEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: stuck,
        expected_version: k.stateVersion,
      }),
    );
    // crash happens here, kernel restarts from log
    const rebuilt = ProjectStateKernel.fromEvents(k.events);
    expect(rebuilt.listExecutingEffects().map((e) => e.id)).toEqual([stuck]);
    expect(rebuilt.listPendingEffects()).toHaveLength(0);
    // recovery runner marks it reset and reopens
    valueOf(
      rebuilt.resetEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: stuck,
        reason: 'recovery runner: never closed',
        expected_version: rebuilt.stateVersion,
      }),
    );
    expect(rebuilt.listPendingEffects().map((e) => e.id)).toEqual([stuck]);
  });

  it('late-cancel on an executing row is still stamped; confirmed close after cancel is refused', () => {
    const k = seed();
    const id = intent(k, 'h');
    valueOf(
      k.beginEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.cancelEffectLate({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        reason: 'stakeholder veto mid-execution',
        expected_version: k.stateVersion,
      }),
    );
    const r = k.closeEffect({
      actor: HUMAN,
      at: T0,
      effect_id: id,
      outcome: 'confirmed',
      expected_version: k.stateVersion,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['reason']).toBe('effect-cancelled');
  });

  it('late-cancelled executing row may still close as failed', () => {
    const k = seed();
    const id = intent(k, 'i');
    valueOf(
      k.beginEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.cancelEffectLate({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        reason: 'stopped by stakeholder',
        expected_version: k.stateVersion,
      }),
    );
    const closed = valueOf(
      k.closeEffect({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        outcome: 'failed',
        expected_version: k.stateVersion,
      }),
    );
    expect(closed.status).toBe('failed');
  });

  it('replay reproduces execution_attempts from the event payload', () => {
    const k = seed();
    const id = intent(k, 'j');
    valueOf(
      k.beginEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        expected_version: k.stateVersion,
      }),
    );
    valueOf(
      k.resetEffectExecution({
        actor: HUMAN,
        at: T0,
        effect_id: id,
        reason: 'reboot',
        expected_version: k.stateVersion,
      }),
    );

    const rebuilt = ProjectStateKernel.fromEvents(k.events);
    expect(rebuilt.listPendingEffects()[0]?.execution_attempts).toBe(1);
  });
});
