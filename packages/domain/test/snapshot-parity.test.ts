import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/state/canonical.js';
import { ProjectStateKernel } from '../src/state/project-state-kernel.js';
import { uuidv7 } from '../src/schema/ids.js';
import {
  serializeProjectionState,
  serializeProjectionStateRecord,
  validateSnapshotUsability,
  extractProjectionState,
} from '../src/state/snapshot.js';
import { projectionSnapshotSchema, type ProjectionSnapshot } from '../src/ports/event-store.js';
import type { StateEvent } from '../src/state/events.js';

/**
 * Restored state is compared with an independent full replay of a real
 * mixed log; input corruption must fail before returning usable state.
 */

const T0 = '2026-01-01T00:00:00.000Z';
const atDay = (n: number): string => new Date(Date.parse(T0) + n * 86_400_000).toISOString();

const HUMAN = '01900000-0000-7000-8000-000000000001';
const AGENT = '01900000-0000-7000-8000-000000000002';

function sha(n: number): string {
  return '0'.repeat(61) + String(n).padStart(3, '0');
}

/** Builds a mixed 200-event history through the kernel's own commands so
 *  every event is a real, gate-passing event: boundary + policy updates,
 *  assets with acceptances and deliveries, holds, agent equips. */
function buildMixedLog(): StateEvent[] {
  const k = new ProjectStateKernel();
  const must = <T>(result: { ok: true; value: T } | { ok: false }): T => {
    if (!result.ok) throw new Error('mixed log command rejected');
    return result.value;
  };
  k.registerParticipant({ participant_id: HUMAN, type: 'human', at: T0 });
  k.registerParticipant({ participant_id: AGENT, type: 'agent', at: T0 });
  k.createProject({ actor: HUMAN, at: T0, title: 'merchant onboarding', expected_version: 0 });
  const work = must(
    k.createWork({
      actor: HUMAN,
      at: T0,
      title: 'onboarding workflow',
      reason: 'business request',
      expected_version: 0,
    }),
  );
  const evidence = must(
    k.createAsset({
      actor: HUMAN,
      at: T0,
      kind: 'evidence',
      scope: 'project',
      expected_version: 0,
    }),
  );
  let lastAsset = evidence.id;
  let step = 0;
  while (k.currentSeq < 200) {
    step += 1;
    const at = atDay(step);
    switch (step % 7) {
      case 0:
        must(
          k.updateBoundary({
            actor: HUMAN,
            at,
            reason: 'refine business boundary',
            boundary: 'boundary ' + String(step),
            expected_version: k.stateVersion,
          }),
        );
        must(
          k.updatePolicy({
            actor: HUMAN,
            at,
            reason: 'capture frequency',
            time_window_days: 3,
            expected_version: k.stateVersion,
          }),
        );
        break;
      case 1: {
        const asset = must(
          k.createAsset({
            actor: AGENT,
            at,
            kind: 'artifact',
            scope: 'project',
            content: { media_type: 'text/plain', storage: 'inline', sha256: sha(step) },
            expected_version: k.stateVersion,
          }),
        );
        lastAsset = asset.id;
        must(
          k.acceptAsset({
            actor: HUMAN,
            at,
            asset_id: asset.id,
            result: 'accepted',
            criteria_snapshot: { criterion: 'merchant can onboard' },
            evidence_refs: [evidence.id],
            expected_version: k.stateVersion,
          }),
        );
        const delivery = must(
          k.deliver({
            actor: HUMAN,
            at,
            asset_id: asset.id,
            target_ref: 'staging-' + String(step),
            target_type: 'staging',
            expected_version: k.stateVersion,
          }),
        );
        must(
          k.confirmDelivery({
            actor: HUMAN,
            at,
            delivery_id: delivery.id,
            outcome: 'confirmed',
            feedback: 'merchant scenario verified',
            expected_version: k.stateVersion,
          }),
        );
        break;
      }
      case 2:
        must(
          k.registerHold({
            actor: HUMAN,
            at,
            kind: 'bug',
            severity: 'medium',
            statement: 'follow-up validation',
            asset_refs: [lastAsset],
            expected_version: k.stateVersion,
          }),
        );
        break;
      case 3:
        must(
          k.issueEquip({
            actor: HUMAN,
            participant_id: AGENT,
            work_id: work.id,
            at,
            expected_version: k.stateVersion,
          }),
        );
        break;
      case 4: {
        const effect = must(
          k.recordEffect({
            actor: AGENT,
            at,
            asset_ref: lastAsset,
            description: 'external check',
            expected_version: k.stateVersion,
          }),
        );
        must(
          k.beginEffectExecution({
            actor: HUMAN,
            at,
            effect_id: effect.id,
            expected_version: k.stateVersion,
          }),
        );
        must(
          k.closeEffect({
            actor: HUMAN,
            at,
            effect_id: effect.id,
            outcome: 'confirmed',
            reason: 'evidence received',
            expected_version: k.stateVersion,
          }),
        );
        break;
      }
      case 5: {
        const equip = must(
          k.issueEquip({
            actor: HUMAN,
            participant_id: AGENT,
            work_id: work.id,
            at,
            expected_version: k.stateVersion,
          }),
        );
        const runId = uuidv7();
        must(
          k.startRun({
            actor: AGENT,
            at,
            run_id: runId,
            work_id: work.id,
            equip_id: equip.id,
            expected_version: k.stateVersion,
          }),
        );
        const sessionId = uuidv7();
        must(
          k.openIntervention({
            actor: HUMAN,
            at,
            run_id: runId,
            session_id: sessionId,
            mode: 'assist',
            run_revision: 1,
            expected_version: k.stateVersion,
          }),
        );
        must(
          k.closeIntervention({
            actor: HUMAN,
            at,
            run_id: runId,
            session_id: sessionId,
            consent_status: 'granted',
            run_revision: 2,
            expected_version: k.stateVersion,
          }),
        );
        must(
          k.transitionRun({
            actor: AGENT,
            at,
            run_id: runId,
            to: 'paused',
            reason: 'handoff',
            run_revision: 3,
            expected_version: k.stateVersion,
            checkpoint_position: { step },
            checkpoint_resume_ref: { token: 'resume-' + String(step) },
          }),
        );
        break;
      }
      case 6: {
        const directionId = uuidv7();
        must(
          k.proposeDirection({
            actor: AGENT,
            at,
            direction_id: directionId,
            title: 'next validation',
          }),
        );
        must(
          k.resolveDirection({
            actor: HUMAN,
            at,
            direction_id: directionId,
            resolution: 'confirmed',
            resolution_reason: 'business priority',
            expected_version: k.stateVersion,
          }),
        );
        break;
      }
    }
  }
  return [...k.events];
}

/** Builds a usable snapshot at the given cursor from a full replay. */
function snapshotAt(events: StateEvent[], cursorSeq: number): ProjectionSnapshot {
  const midway = ProjectStateKernel.fromEvents(events.filter((e) => e.seq <= cursorSeq));
  const midProjection = midway.rebuildProjection();
  const cursorEvent = events[cursorSeq - 1];
  if (cursorEvent === undefined) throw new Error('fixture: cursor beyond the log');
  return {
    state_version: cursorEvent.state_version,
    seq: cursorSeq,
    schema_version: 1,
    state: { ...serializeProjectionStateRecord({ ...midProjection }), seq: cursorSeq },
  };
}

describe('restore-then-fold parity', () => {
  it('replay returns an immutable view and rejects unsupported event versions', () => {
    const events = buildMixedLog();
    const k = ProjectStateKernel.fromEvents(events);
    const view = k.rebuildProjection(snapshotAt(events, 100));
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => {
      (view.project as { title: string }).title = 'changed';
    }).toThrow();
    expect(() =>
      ProjectStateKernel.fromEvents(
        events.map((event, i) => (i === 0 ? { ...event, schema_version: 999 } : event)),
      ),
    ).toThrow(/unsupported schema version/);
  });

  it('rejects business rows in a snapshot before project creation', () => {
    const k = new ProjectStateKernel();
    k.registerParticipant({ participant_id: HUMAN, type: 'human', at: T0 });
    const state = serializeProjectionStateRecord(k.projection);
    const id = '01900000-0000-7000-8000-000000000003';
    state['works'] = {
      [id]: {
        id,
        project_id: HUMAN,
        title: 'phantom',
        status: 'planned',
        aggregate_revision: 1,
        created_at: T0,
      },
    };
    expect(() =>
      ProjectStateKernel.fromEvents(k.events, {
        state_version: 0,
        seq: 1,
        schema_version: 1,
        state,
      }),
    ).toThrow(/business rows before project creation/);
  });

  it('rejects a snapshot that promotes a candidate without acceptance', () => {
    const k = new ProjectStateKernel();
    k.registerParticipant({ participant_id: HUMAN, type: 'human', at: T0 });
    k.createProject({ actor: HUMAN, at: T0, title: 'p', expected_version: 0 });
    const asset = k.createAsset({
      actor: HUMAN,
      at: T0,
      kind: 'artifact',
      scope: 'project',
      expected_version: 0,
    });
    if (!asset.ok) throw new Error('candidate fixture failed');
    const state: Record<string, unknown> = serializeProjectionStateRecord(k.projection);
    state['assets'] = { [asset.value.id]: { ...asset.value, lifecycle: 'active' } };
    expect(() =>
      ProjectStateKernel.fromEvents(
        k.events,
        projectionSnapshotSchema.parse({
          seq: k.currentSeq,
          state_version: 0,
          schema_version: 1,
          state,
        }),
      ),
    ).toThrow(/without acceptance/);
  });
  it('restore plus increment is canonically identical to a full replay (200-event mixed log)', () => {
    const events = buildMixedLog();
    for (const type of [
      'asset.created',
      'acceptance.recorded',
      'delivery.confirmed',
      'hold.registered',
      'workrun.transitioned',
      'intervention.session_closed',
      'direction.resolved',
      'project.policy_updated',
      'project.boundary_updated',
      'effect.closed',
    ]) {
      expect(
        events.some((event) => event.type === type),
        type,
      ).toBe(true);
    }
    expect(events.length).toBeGreaterThanOrEqual(200);
    const full = ProjectStateKernel.fromEvents(events);
    expect(full.projection.project).not.toBeNull();

    const cursorSeq = 100;
    const restored = ProjectStateKernel.fromEvents(events, snapshotAt(events, cursorSeq));
    expect(canonicalJson(restored.projection)).toBe(canonicalJson(full.projection));
  });

  it('parity holds at several cursor positions, including the head and a State-material cursor', () => {
    const events = buildMixedLog();
    const full = ProjectStateKernel.fromEvents(events);
    const head = events[events.length - 1];
    if (head === undefined) throw new Error('fixture: empty log');
    for (const cursorSeq of [1, 3, 50, 151, head.seq]) {
      const restored = ProjectStateKernel.fromEvents(events, snapshotAt(events, cursorSeq));
      expect(canonicalJson(restored.projection), `cursor ${String(cursorSeq)}`).toBe(
        canonicalJson(full.projection),
      );
    }
  });

  it('a supplied snapshot leaves the causal clock rebuilt from the folded events', () => {
    const events = buildMixedLog();
    const full = ProjectStateKernel.fromEvents(events);
    const restored = ProjectStateKernel.fromEvents(events, snapshotAt(events, 100));
    expect(canonicalJson(restored.causal_clock)).toBe(canonicalJson(full.causal_clock));
  });

  it('no snapshot supplied means a full fold', () => {
    const events = buildMixedLog();
    const full = ProjectStateKernel.fromEvents(events);
    const fresh = ProjectStateKernel.fromEvents(events);
    expect(canonicalJson(fresh.projection)).toBe(canonicalJson(full.projection));
    const rebuilt = full.rebuildProjection();
    expect(canonicalJson(rebuilt)).toBe(canonicalJson(full.projection));
  });

  it('an unusable snapshot (schema-version mismatch) fails loudly, no silent fallback', () => {
    const events = buildMixedLog();
    const wrong = { ...snapshotAt(events, 100), schema_version: 999 };
    expect(() => ProjectStateKernel.fromEvents(events, wrong)).toThrow(/schema version/);
    expect(() => ProjectStateKernel.fromEvents(events, wrong)).toThrow(/999/);
  });

  it('an unusable snapshot (cursor not in the log) fails loudly', () => {
    const events = buildMixedLog();
    const wrong = { ...snapshotAt(events, 100), seq: 100.5 };
    wrong.state = { ...wrong.state, seq: 100.5 };
    expect(() => ProjectStateKernel.fromEvents(events, wrong)).toThrow(/cursor/);
  });

  it('an unusable snapshot (state-version disagreement) fails loudly', () => {
    const events = buildMixedLog();
    const wrong = { ...snapshotAt(events, 100), state_version: 4242 };
    expect(() => ProjectStateKernel.fromEvents(events, wrong)).toThrow(/state-version/);
  });

  it('an unusable snapshot (state missing a projection field) fails loudly', () => {
    const events = buildMixedLog();
    const wrong: ProjectionSnapshot = {
      state_version: 0,
      seq: 100,
      schema_version: 1,
      state: { seq: 100 }, // every projection field missing
    };
    expect(() => ProjectStateKernel.fromEvents(events, wrong)).toThrow(/unusable snapshot/);
  });

  it('rebuildProjection accepts the same snapshot contract as fromEvents', () => {
    const events = buildMixedLog();
    const full = ProjectStateKernel.fromEvents(events);
    const restored = ProjectStateKernel.fromEvents(events, snapshotAt(events, 60));
    const rebuilt = restored.rebuildProjection(snapshotAt(events, 60));
    expect(canonicalJson(rebuilt)).toBe(canonicalJson(full.projection));
  });

  it('rebuildProjection fails loudly on an unusable snapshot (restoreThenFold path)', () => {
    const events = buildMixedLog();
    const k = ProjectStateKernel.fromEvents(events);
    const unusable: ProjectionSnapshot = {
      state_version: 999,
      seq: 5,
      schema_version: 1,
      state: { project: null, seq: 5 },
    };
    expect(() => k.rebuildProjection(unusable)).toThrow(/unusable snapshot/);
  });
});
it('fromEvents throws on an unusable snapshot before extracting projection state', () => {
  const events = buildMixedLog();
  const head = events[events.length - 1];
  if (head === undefined) throw new Error('fixture: empty log');
  const unusable: ProjectionSnapshot = {
    state_version: 999,
    seq: 5,
    schema_version: 1,
    state: { project: null, seq: 5 },
  };
  expect(() => ProjectStateKernel.fromEvents(events, unusable)).toThrow(/unusable snapshot/);
});

it('fromEvents throws when an unregistered actor appears after the restore point', () => {
  const events = buildMixedLog();
  const head = events[events.length - 1];
  if (head === undefined) throw new Error('fixture: empty log');
  const mid = snapshotAt(events, 100);
  // Forge one extra event past the head carrying an unregistered actor.
  events.push({ ...head, seq: head.seq + 1, actor: '01999999-0000-7000-8000-00000000ffff' });
  expect(() => ProjectStateKernel.fromEvents(events, mid)).toThrow(/actor not registered/);
});

it('a stored snapshot whose projection payload is malformed is rejected, not trusted', () => {
  const events = buildMixedLog();
  const snapshot = snapshotAt(events, 50);

  const corruptSnapshot = {
    ...snapshot,
    state: { ...snapshot.state, assets: 'not-an-object' },
  };

  const result = validateSnapshotUsability(corruptSnapshot, events, 1);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toContain('invalid');
  }
});

it('extractProjectionState names the failing projection path for a corrupted record', () => {
  const events = buildMixedLog();
  const k = ProjectStateKernel.fromEvents(events);
  const projection = k.projection;
  const serialized = serializeProjectionState(projection);

  const corruptState = { ...serialized, participants: null };

  expect(() => extractProjectionState(corruptState)).toThrow(
    /invalid snapshot projection at participants/,
  );
});

it('a projection with a well-formed envelope but invalid rows cannot round-trip into the kernel', () => {
  // Construct a state that will fail parsing but pass the initial field checks
  const badState = {
    seq: 1,
    participants: {},
    project: {},
    assets: {},
    acceptances: {},
    deliveries: {},
    holds: {},
    works: {},
    equips: {},
    intended_directions: {},
    checkpoints: {},
    effects: {},
    work_runs: {},
    policy: null,
  };

  expect(() => extractProjectionState(badState)).toThrow(/invalid snapshot projection/);
});
