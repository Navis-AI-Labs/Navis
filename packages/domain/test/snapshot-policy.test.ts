import { describe, expect, it } from 'vitest';

import {
  CAPTURE_EVENT_COUNT_WINDOW_DEFAULT,
  CAPTURE_TIME_WINDOW_DAYS_DEFAULT,
  ProjectStateKernel,
} from '../src/state/project-state-kernel.js';
import {
  evaluateCaptureDue,
  extractCaptureAnchor,
  extractProjectionState,
  validateSnapshotUsability,
  type CaptureDueInput,
} from '../src/state/snapshot.js';
import type { ProjectionSnapshot } from '../src/ports/event-store.js';

/**
 * Policy changes remain human-governed and version-neutral; capture
 * decisions depend on recorded logical time rather than the test clock.
 */

const T0 = '2026-01-01T00:00:00.000Z';
/** Exact logical day offsets from T0 — logical time only, never a wall clock. */
const atDay = (n: number): string => new Date(Date.parse(T0) + n * 86_400_000).toISOString();

const HUMAN = '01900000-0000-7000-8000-000000000001';
const AGENT = '01900000-0000-7000-8000-000000000002';

function seedKernel(): ProjectStateKernel {
  const k = new ProjectStateKernel();
  k.registerParticipant({ participant_id: HUMAN, type: 'human', at: T0 });
  k.registerParticipant({ participant_id: AGENT, type: 'agent', at: T0 });
  k.createProject({ actor: HUMAN, at: T0, title: 'p', expected_version: 0 });
  return k;
}

describe('policy row seed', () => {
  it('seeds the accepted capture-window defaults at project creation', () => {
    const k = seedKernel();
    expect(k.projection.policy).toEqual({
      event_count_window: CAPTURE_EVENT_COUNT_WINDOW_DEFAULT,
      time_window_days: CAPTURE_TIME_WINDOW_DAYS_DEFAULT,
      updated_at: T0,
      updated_by: HUMAN,
    });
    expect(CAPTURE_EVENT_COUNT_WINDOW_DEFAULT).toBe(500);
    expect(CAPTURE_TIME_WINDOW_DAYS_DEFAULT).toBe(7);
  });

  it('a projection without a project has no policy row', () => {
    expect(new ProjectStateKernel().projection.policy).toBeNull();
  });
});

describe('updatePolicy governance', () => {
  it('rejects an omitted reason from an untyped caller', () => {
    const k = seedKernel();
    const before = k.events;
    const result = k.updatePolicy({
      actor: HUMAN,
      at: T0,
      event_count_window: 10,
      expected_version: 0,
    } as Parameters<ProjectStateKernel['updatePolicy']>[0]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('rationale-required');
    expect(k.events).toEqual(before);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid count window %s without mutation',
    (event_count_window) => {
      const k = seedKernel();
      const before = k.events;
      const clock = k.causal_clock;
      expect(
        k.updatePolicy({
          actor: HUMAN,
          at: T0,
          reason: 'update',
          event_count_window,
          expected_version: 0,
        }).ok,
      ).toBe(false);
      expect(k.events).toEqual(before);
      expect(k.causal_clock).toEqual(clock);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid time window %s',
    (time_window_days) => {
      const k = seedKernel();
      expect(
        k.updatePolicy({
          actor: HUMAN,
          at: T0,
          reason: 'update',
          time_window_days,
          expected_version: 0,
        }).ok,
      ).toBe(false);
    },
  );
  it('a human update with a reason advances the policy row and appends the event', () => {
    const k = seedKernel();
    const result = k.updatePolicy({
      actor: HUMAN,
      at: T0,
      reason: 'shrink the capture window for this project',
      event_count_window: 100,
      time_window_days: 2,
      expected_version: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.event_count_window).toBe(100);
      expect(result.value.time_window_days).toBe(2);
      expect(result.value.updated_at).toBe(T0);
    }
    const event = k.events[k.events.length - 1];
    if (event === undefined) throw new Error('fixture: policy event missing');
    expect(event.type).toBe('project.policy_updated');
    expect(event.seq).toBe(4); // register, register, create, policy
  });

  it('an agent-attempted update is forbidden with zero state pollution', () => {
    const k = seedKernel();
    const before = [...k.events];
    const result = k.updatePolicy({
      actor: AGENT,
      at: T0,
      reason: 'agents cannot set policy',
      event_count_window: 1,
      expected_version: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details).toMatchObject({ action: 'update_policy', actor_kind: 'agent' });
    }
    expect(k.events).toEqual(before); // no event appended
    expect(k.projection.policy?.event_count_window).toBe(CAPTURE_EVENT_COUNT_WINDOW_DEFAULT);
  });

  it('a missing (empty/whitespace) reason is rejected without an event', () => {
    const k = seedKernel();
    const before = [...k.events];
    const result = k.updatePolicy({
      actor: HUMAN,
      at: T0,
      reason: '   ',
      event_count_window: 100,
      expected_version: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('rationale-required');
    expect(k.events).toEqual(before);
  });

  it('an update with no window value is rejected as a no-op', () => {
    const k = seedKernel();
    const before = [...k.events];
    const result = k.updatePolicy({
      actor: HUMAN,
      at: T0,
      reason: 'change nothing',
      expected_version: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details).toMatchObject({ action: 'update_policy', reason: 'no-op' });
    }
    expect(k.events).toEqual(before);
  });

  it('a stale expected version fails with version-conflict and appends nothing', () => {
    const k = seedKernel();
    const before = [...k.events];
    const result = k.updatePolicy({
      actor: HUMAN,
      at: T0,
      reason: 'r',
      event_count_window: 100,
      expected_version: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('version-conflict');
    expect(k.events).toEqual(before);
  });
});

describe('version semantics of the policy event', () => {
  it('a policy update advances seq and repeats the current state version', () => {
    const k = seedKernel();
    const before = k.stateVersion;
    const seqBefore = k.currentSeq;
    const result = k.updatePolicy({
      actor: HUMAN,
      at: T0,
      reason: 'r',
      event_count_window: 100,
      expected_version: 0,
    });
    expect(result.ok).toBe(true);
    expect(k.currentSeq).toBe(seqBefore + 1); // seq advanced
    expect(k.stateVersion).toBe(before); // version repeated, not advanced
    expect(k.events[k.events.length - 1]?.state_version).toBe(before);
  });

  it('boundary fields are untouched by a policy update', () => {
    const k = seedKernel();
    k.updateBoundary({
      actor: HUMAN,
      at: T0,
      reason: 'set boundary',
      boundary: 'B1',
      expected_version: 0,
    });
    const projectBefore = k.projection.project;
    const result = k.updatePolicy({
      actor: HUMAN,
      at: T0,
      reason: 'r',
      time_window_days: 3,
      expected_version: 1,
    });
    expect(result.ok).toBe(true);
    expect(k.projection.project?.boundary).toBe('B1');
    expect(k.projection.project?.current_state_version).toBe(projectBefore?.current_state_version);
  });

  it('a policy update does not invalidate equips bound to the current version', () => {
    const k = seedKernel();
    // an agent equip binds to the current state version
    const issued = k.issueEquip({ actor: AGENT, at: T0, expected_version: 0 });
    expect(issued.ok).toBe(true);
    const equipStateVersion = (issued as { ok: true; value: { state_version: number } }).value
      .state_version;
    expect(equipStateVersion).toBe(k.stateVersion);
    const before = k.currentSeq;
    const result = k.updatePolicy({
      actor: HUMAN,
      at: T0,
      reason: 'r',
      event_count_window: 100,
      expected_version: 0,
    });
    expect(result.ok).toBe(true);
    expect(k.currentSeq).toBe(before + 1);
    // non-State-material: the recorded version repeats, so no equip at the
    // current version can read as stale — by construction
    expect(k.events[k.events.length - 1]?.state_version).toBe(equipStateVersion);
  });
});

describe('forward-only policy windows', () => {
  it('evaluations after the change use the new value; prior state keeps the old', () => {
    const k = seedKernel();
    expect(k.projection.policy?.event_count_window).toBe(500);
    const result = k.updatePolicy({
      actor: HUMAN,
      at: atDay(1),
      reason: 'r',
      event_count_window: 50,
      expected_version: 0,
    });
    expect(result.ok).toBe(true);
    expect(k.projection.policy?.event_count_window).toBe(50);
    // the policy row's own history is ledger-carried: the earlier rows/reads
    // were produced under the old value and are never re-judged
    const policyEvents = k.events.filter((e) => e.type === 'project.policy_updated');
    expect(policyEvents).toHaveLength(1);
    expect(policyEvents[0]?.at).toBe(atDay(1));
  });
});

describe('capture due-ness', () => {
  const base = (overrides?: Partial<CaptureDueInput>): CaptureDueInput => ({
    events: [
      { seq: 1, at: atDay(0) },
      { seq: 2, at: atDay(1) },
      { seq: 3, at: atDay(2) },
    ],
    policy: { event_count_window: 500, time_window_days: 7 },
    anchor: null,
    ...overrides,
  });

  it('an empty log is never due', () => {
    const evals = evaluateCaptureDue(base({ events: [] }));
    expect(evals.due).toBe(false);
    expect(evals.trigger).toBeNull();
  });

  it('the count window fires at the configured number of events since the anchor', () => {
    // window 3, anchor after seq 0 → events 1..3 make the count reach 3
    const evals = evaluateCaptureDue(
      base({ policy: { event_count_window: 3, time_window_days: 7 } }),
    );
    expect(evals.due).toBe(true);
    expect(evals.trigger).toBe('event-count');
    expect(evals.events_since_anchor).toBe(3);
  });

  it('the time window fires first when fewer events than the count window occurred', () => {
    const evals = evaluateCaptureDue(
      base({
        policy: { event_count_window: 500, time_window_days: 2 },
        anchor: { seq: 1, at: atDay(0) },
      }),
    );
    // head seq 3 (2 since anchor), logical day 2 vs anchor day 0 → 2 days elapsed
    expect(evals.due).toBe(true);
    expect(evals.trigger).toBe('time-window');
    expect(evals.events_since_anchor).toBe(2);
    expect(evals.logical_days_since_anchor).toBeCloseTo(2, 6);
  });

  it('neither window fires before either threshold is reached', () => {
    const evals = evaluateCaptureDue(
      base({
        policy: { event_count_window: 500, time_window_days: 7 },
        anchor: { seq: 3, at: atDay(2) },
      }),
    );
    expect(evals.due).toBe(false);
    expect(evals.trigger).toBeNull();
  });

  it('due-ness is log-deterministic: the same log and policy answer identically', () => {
    const input = base({
      policy: { event_count_window: 3, time_window_days: 7 },
      anchor: { seq: 1, at: atDay(0) },
    });
    const first = evaluateCaptureDue(input);
    const second = evaluateCaptureDue(input);
    expect(first).toEqual(second);
  });

  it('the policy row in force feeds the evaluation through the live projection', () => {
    const k = seedKernel();
    // default windows: 3 events total → not due at count 500 / 7 days
    const before = evaluateCaptureDue({
      events: k.events.map((e) => ({ seq: e.seq, at: e.at })),
      policy: k.projection.policy ?? { event_count_window: 500, time_window_days: 7 },
      anchor: null,
    });
    expect(before.due).toBe(false);
    const update = k.updatePolicy({
      actor: HUMAN,
      at: atDay(1),
      reason: 'tighten windows',
      event_count_window: 2,
      expected_version: 0,
    });
    expect(update.ok).toBe(true);
    const after = evaluateCaptureDue({
      events: k.events.map((e) => ({ seq: e.seq, at: e.at })),
      policy: k.projection.policy ?? { event_count_window: 500, time_window_days: 7 },
      anchor: null,
    });
    expect(after.due).toBe(true);
    expect(after.trigger).toBe('event-count');
  });

  it('the capture anchor round-trips through the snapshot state payload', () => {
    const anchor = { seq: 12, at: atDay(3) };
    const state = { capture_anchor: anchor, extra: 'kept' };
    expect(extractCaptureAnchor(state)).toEqual(anchor);
    expect(extractCaptureAnchor({})).toBeNull(); // no capture recorded yet
    expect(() => extractCaptureAnchor({ capture_anchor: { seq: 'x', at: atDay(0) } })).toThrow(
      /anchor/,
    );
    expect(() => extractCaptureAnchor({ capture_anchor: { seq: 1, at: 'not-a-time' } })).toThrow(
      /anchor/,
    );
  });
});

describe('due-ness and usability defensive edges', () => {
  it('due-ness throws on an invalid logical timestamp in the log or anchor', () => {
    const events = [{ seq: 1, at: 'not-a-timestamp' }];
    expect(() =>
      evaluateCaptureDue({
        events,
        policy: { event_count_window: 500, time_window_days: 7 },
        anchor: null,
      }),
    ).toThrow(/invalid logical timestamp/);
    expect(() =>
      evaluateCaptureDue({
        events: [{ seq: 1, at: '2026-09-01T00:00:00.000Z' }],
        policy: { event_count_window: 500, time_window_days: 7 },
        anchor: { seq: 0, at: 'also-bad' },
      }),
    ).toThrow(/invalid logical timestamp/);
  });

  it('usability rejects a snapshot whose state seq disagrees with the envelope seq', () => {
    const snapshot: ProjectionSnapshot = {
      state_version: 0,
      seq: 5,
      schema_version: 1,
      state: { project: null, seq: 4 }, // state seq 4 !== envelope seq 5
    };
    const result = validateSnapshotUsability(
      snapshot,
      [{ seq: 5, type: 'project.created', data: {}, at: T0, state_version: 0, schema_version: 1 }],
      1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/state seq cursor disagrees/);
  });

  it('extractProjectionState rejects an undefined collection instead of inventing a replacement', () => {
    const state: Record<string, unknown> = {
      seq: 0,
      project: null,
      works: {},
      participants: undefined,
      assets: {},
      acceptances: {},
      deliveries: {},
      holds: {},
      effects: {},
      equips: {},
      equip_returns: {},
      work_runs: {},
      checkpoints: {},
      intended_directions: {},
      policy: null,
    };
    expect(() => extractProjectionState(state)).toThrow(/participants/);
  });
});
it('extractProjectionState throws naming the first missing projection field', () => {
  expect(() => extractProjectionState({ seq: 0, project: null })).toThrow(/missing the 'policy'/);
});
