import { describe, expect, it } from 'vitest';

import {
  archivableEventTypes,
  eventRetentionClass,
  projectionSnapshotSchema,
} from '../src/ports/event-store.js';
import {
  extractCaptureAnchor,
  serializeProjectionState,
  validateSnapshotUsability,
} from '../src/state/snapshot.js';
import type { ProjectionSnapshot } from '../src/ports/event-store.js';
import { ProjectStateKernel } from '../src/state/project-state-kernel.js';
import type { StateEvent } from '../src/state/events.js';

/**
 * EventStore contracts: retention classification is a pure port-level rule
 * (unknown families stay permanent until their policy is defined), and the
 * snapshot envelope pins the state-seq cursor identity plus the restore
 * validation branches the capture/restore seams rely on.
 */

const T0 = '2026-01-01T00:00:00.000Z';

function registeredKernel(): ProjectStateKernel {
  const k = new ProjectStateKernel();
  k.registerParticipant({
    participant_id: '01900000-0000-7000-8000-000000000001',
    type: 'human',
    at: T0,
  });
  return k;
}

function logEvent(seq: number, stateVersion: number): StateEvent {
  const event = registeredKernel().events.at(-1);
  if (event === undefined) throw new Error('registration fixture missing');
  return { ...event, seq, state_version: stateVersion };
}

function minimalState(overrides: Record<string, unknown>): ProjectionSnapshot['state'] {
  return projectionSnapshotSchema.shape.state.parse({
    ...serializeProjectionState(registeredKernel().projection),
    ...overrides,
  });
}

describe('retention classification', () => {
  it('classifies the three accepted archivable families as archive_after_snapshot', () => {
    expect(archivableEventTypes).toEqual([
      'asset.created',
      'workrun.started',
      'workrun.transitioned',
    ]);
    for (const type of archivableEventTypes) {
      expect(eventRetentionClass(type)).toBe('archive_after_snapshot');
    }
  });

  it('keeps unknown and permanent families permanent until a policy defines them', () => {
    expect(eventRetentionClass('future.undefined.event')).toBe('permanent');
    expect(eventRetentionClass('project.boundary_updated')).toBe('permanent');
    expect(eventRetentionClass('')).toBe('permanent');
  });
});

describe('projection snapshot envelope', () => {
  it('accepts a state whose seq cursor equals the envelope seq', () => {
    const parsed = projectionSnapshotSchema.safeParse({
      state_version: 0,
      seq: 3,
      schema_version: 1,
      state: { seq: 3 },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a state that lacks the seq cursor or disagrees with the envelope', () => {
    const missing = projectionSnapshotSchema.safeParse({
      state_version: 0,
      seq: 3,
      schema_version: 1,
      state: {},
    });
    expect(missing.success).toBe(false);

    const disagreeing = projectionSnapshotSchema.safeParse({
      state_version: 0,
      seq: 3,
      schema_version: 1,
      state: { seq: 2 },
    });
    expect(disagreeing.success).toBe(false);
  });
});

describe('snapshot usability', () => {
  it('rejects an unusable projection state payload, naming the corrupted field', () => {
    const snapshot: ProjectionSnapshot = {
      state_version: 0,
      seq: 1,
      schema_version: 1,
      state: minimalState({ project: { id: 'not-a-uuid' } }),
    };
    const result = validateSnapshotUsability(snapshot, [logEvent(1, 0)], 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/project/);
  });

  it('rejects a project-carrying state when the log has no project.created at or before the cursor', () => {
    const snapshot: ProjectionSnapshot = {
      state_version: 0,
      seq: 1,
      schema_version: 1,
      state: minimalState({
        project: {
          id: '01900000-0000-7000-8000-000000000099',
          title: 'ghost',
          status: 'active',
          current_state_version: 0,
          created_at: T0,
        },
      }),
    };
    const result = validateSnapshotUsability(snapshot, [logEvent(1, 0)], 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/disagrees with its event cursor/);
  });

  it('rejects a capture anchor that disagrees with the covered event', () => {
    const snapshot: ProjectionSnapshot = {
      state_version: 0,
      seq: 1,
      schema_version: 1,
      state: minimalState({ capture_anchor: { seq: 1, at: '2026-02-01T00:00:00.000Z' } }),
    };
    // A non-creation log keeps the project/policy checks consistent so the
    // anchor branch is the one under test.
    const result = validateSnapshotUsability(snapshot, [logEvent(1, 0)], 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/anchor disagrees/);
  });

  it('rejects acceptance rows whose cross-field constraints were dropped by field reuse', () => {
    const withoutRationale = minimalState({});
    withoutRationale['acceptances'] = {
      '01900000-0000-7000-8000-000000000201': {
        id: '01900000-0000-7000-8000-000000000201',
        asset_id: '01900000-0000-7000-8000-000000000202',
        result: 'conditional',
        criteria_snapshot: {},
        actor: '01900000-0000-7000-8000-000000000001',
        created_at: T0,
      },
    };
    const rejectedRow = minimalState({});
    rejectedRow['acceptances'] = {
      '01900000-0000-7000-8000-000000000203': {
        id: '01900000-0000-7000-8000-000000000203',
        asset_id: '01900000-0000-7000-8000-000000000202',
        result: 'rejected',
        rationale: '   ',
        criteria_snapshot: {},
        actor: '01900000-0000-7000-8000-000000000001',
        created_at: T0,
      },
    };
    const events = [logEvent(1, 0)];
    const first = validateSnapshotUsability(
      { state_version: 0, seq: 1, schema_version: 1, state: withoutRationale },
      events,
      1,
    );
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.reason).toMatch(/rationale/);
    const second = validateSnapshotUsability(
      { state_version: 0, seq: 1, schema_version: 1, state: rejectedRow },
      events,
      1,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/rationale/);
  });

  it('accepts a consistent pre-creation snapshot with a matching anchor', () => {
    const snapshot: ProjectionSnapshot = {
      state_version: 0,
      seq: 1,
      schema_version: 1,
      state: minimalState({ capture_anchor: { seq: 1, at: T0 } }),
    };
    const result = validateSnapshotUsability(snapshot, [logEvent(1, 0)], 1);
    expect(result.ok).toBe(true);
  });
});

describe('capture anchor shape', () => {
  it('reads a well-formed anchor and ignores an absent one', () => {
    expect(extractCaptureAnchor({ capture_anchor: { seq: 2, at: T0 } })).toEqual({
      seq: 2,
      at: T0,
    });
    expect(extractCaptureAnchor({})).toBeNull();
    expect(extractCaptureAnchor({ capture_anchor: null })).toBeNull();
  });
});
