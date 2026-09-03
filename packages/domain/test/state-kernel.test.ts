import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/state/canonical.js';
import {
  COMPETITIVE_GRACE_PERIOD_DAYS,
  EQUIP_SIZE_BUDGET,
  KERNEL_EVENT_TYPES,
  ProjectStateKernel,
} from '../src/state/project-state-kernel.js';
import type { StateEvent } from '../src/state/events.js';

/**
 * Task 4.2 suite — the T9/T17b/T20-T26 product assertions ported onto the
 * real kernel (design.md: the research simulation scripts were the
 * prototype; these suites are the product), plus the spec scenarios of
 * project-state-kernel.
 *
 * Version bookkeeping: project.created is NOT State-material, so a fresh
 * project sits at state_version 0; only boundary updates and project
 * status changes advance it. Every other command repeats the current
 * version (its expected_version equals the version it observed).
 */

const T0 = '2026-01-01T00:00:00.000Z';
/** Exact logical day offsets from T0 — the grace/purge gates count real days. */
const atDay = (n: number): string => new Date(Date.parse(T0) + n * 86_400_000).toISOString();

/** Fixture: one human, one agent, one active project at state_version 0. */
function seedKernel(): { k: ProjectStateKernel; human: string; agent: string; v: () => number } {
  const k = new ProjectStateKernel();
  const human = '01900000-0000-7000-8000-000000000001';
  const agent = '01900000-0000-7000-8000-000000000002';
  k.registerParticipant({ participant_id: human, type: 'human', at: T0 });
  k.registerParticipant({ participant_id: agent, type: 'agent', at: T0 });
  k.createProject({ actor: human, at: T0, title: 'p', expected_version: 0 });
  return { k, human, agent, v: () => k.stateVersion };
}

/** Creates an accepted project-scope deliverable asset (content sha256 present). */
function activeAsset(k: ProjectStateKernel, human: string, at: string): string {
  const created = k.createAsset({
    actor: human,
    at,
    kind: 'artifact',
    scope: 'project',
    content: { storage: 'inline', sha256: 'a'.repeat(64) },
    expected_version: k.stateVersion,
  });
  expect(created.ok).toBe(true);
  const assetId = (created as { ok: true; value: { id: string } }).value.id;
  const accepted = k.acceptAsset({
    actor: human,
    at,
    asset_id: assetId,
    result: 'accepted',
    criteria_snapshot: { rule: 'r1' },
    expected_version: k.stateVersion,
  });
  expect(accepted.ok).toBe(true);
  return assetId;
}

function expectErr(r: { ok: boolean; error?: { code: string; urn: string } }, code: string): void {
  expect(r.ok).toBe(false);
  expect(r.error?.code).toBe(code);
  expect(r.error?.urn).toBe(`kernel/${code}`);
}

/** First key of a projection record; throws when the projection row is missing. */
function firstKey(record: Record<string, unknown>): string {
  const key = Object.keys(record)[0];
  if (key === undefined) throw new Error('expected a non-empty projection record');
  return key;
}

function valueOf<T>(r: { ok: boolean; value?: T }): T {
  expect(r.ok).toBe(true);
  return (r as { ok: true; value: T }).value;
}

describe('kernel: registry discipline', () => {
  it('every emitted event type is in the closed vocabulary', () => {
    const { k, human, agent } = seedKernel();
    k.createAsset({
      actor: human,
      at: T0,
      kind: 'artifact',
      scope: 'project',
      expected_version: 0,
    });
    k.registerHold({
      actor: agent,
      at: T0,
      kind: 'bug',
      severity: 'high',
      statement: 's',
      expected_version: 0,
    });
    k.issueEquip({ actor: agent, at: T0, expected_version: 0 });
    for (const e of k.events) expect(KERNEL_EVENT_TYPES).toContain(e.type);
  });
});

describe('kernel: append-only history + optimistic concurrency (T9, T17b)', () => {
  it('seq is monotonic 1..n; non-State-material events repeat the version', () => {
    const { k, human } = seedKernel();
    k.createAsset({
      actor: human,
      at: T0,
      kind: 'artifact',
      scope: 'project',
      expected_version: 0,
    });
    expect(k.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(k.stateVersion).toBe(0); // creation is not State-material
  });

  it('stale and divergent expected versions both fail with version-conflict; log unchanged', () => {
    const { k, human } = seedKernel();
    const before = k.currentSeq;
    expectErr(
      k.createAsset({
        actor: human,
        at: T0,
        kind: 'artifact',
        scope: 'project',
        expected_version: 5,
      }),
      'version-conflict',
    );
    expectErr(
      k.createAsset({
        actor: human,
        at: T0,
        kind: 'artifact',
        scope: 'project',
        expected_version: 1,
      }),
      'version-conflict',
    );
    expect(k.currentSeq).toBe(before);
  });

  it('the public surface offers no update/delete path on events; events are frozen', () => {
    const { k } = seedKernel();
    const surface = Object.getOwnPropertyNames(ProjectStateKernel.prototype);
    // No method mutates or removes appended events: updateBoundary is the
    // domain action on Project.boundary, not an event edit.
    expect(surface.filter((m) => /delete|remove|rewrite|mutate|revise/i.test(m))).toEqual([]);
    const head = k.events[k.events.length - 1];
    expect(Object.isFrozen(head)).toBe(true);
  });
});

describe('kernel: boundary (human-only, reason-gated, State-material)', () => {
  it('human update advances version exactly 1 and marks equips stale', () => {
    const { k, human, agent } = seedKernel();
    const equipId = valueOf(k.issueEquip({ actor: agent, at: T0, expected_version: 0 })).id;
    expect(k.projection.equips[equipId]?.status).toBe('active');
    k.updateBoundary({
      actor: human,
      at: T0,
      reason: 'pivot',
      boundary: 'new boundary',
      expected_version: 0,
    });
    expect(k.stateVersion).toBe(1);
    expect(k.projection.equips[equipId]?.status).toBe('stale');
  });

  it('agent update is forbidden with zero pollution; missing reason rejected', () => {
    const { k, agent, human } = seedKernel();
    const seq = k.currentSeq;
    expectErr(
      k.updateBoundary({ actor: agent, at: T0, reason: 'x', boundary: 'b', expected_version: 0 }),
      'forbidden',
    );
    expectErr(
      k.updateBoundary({ actor: human, at: T0, reason: '', boundary: 'b', expected_version: 0 }),
      'rationale-required',
    );
    expect(k.currentSeq).toBe(seq);
    expect(k.stateVersion).toBe(0);
  });

  it('redirect_work advances seq and the Work revision without the version; checkpoint created', () => {
    const { k, human } = seedKernel();
    const workId = valueOf(
      k.createWork({ actor: human, at: T0, reason: 'start', title: 'w', expected_version: 0 }),
    ).id;
    const seq = k.currentSeq;
    k.redirectWork({
      actor: human,
      at: T0,
      reason: 'method fix',
      work_id: workId,
      direction: 'new dir',
      expected_version: 0,
    });
    expect(k.currentSeq).toBe(seq + 1);
    expect(k.stateVersion).toBe(0);
    expect(k.projection.works[workId]?.direction).toBe('new dir');
    expect(k.projection.works[workId]?.aggregate_revision).toBe(2);
    expect(Object.keys(k.projection.checkpoints)).toHaveLength(1);
  });
});

describe('kernel: project lifecycle (human-gated, non-destructive)', () => {
  it('pause locks the four gated families; resume unlocks', () => {
    const { k, human, agent } = seedKernel();
    k.setProjectStatus({ actor: human, at: T0, reason: 'rest', to: 'paused', expected_version: 0 });
    const v = k.stateVersion; // 1
    expectErr(
      k.updateBoundary({ actor: human, at: T0, reason: 'r', boundary: 'b', expected_version: v }),
      'project-not-active',
    );
    expectErr(k.issueEquip({ actor: agent, at: T0, expected_version: v }), 'project-not-active');
    expectErr(
      k.submitReturn({ actor: agent, at: T0, equip_id: 'nope', expected_version: v }),
      'project-not-active',
    );
    expect(
      k.setProjectStatus({
        actor: human,
        at: T0,
        reason: 'back',
        to: 'active',
        expected_version: v,
      }).ok,
    ).toBe(true);
    expect(
      k.updateBoundary({
        actor: human,
        at: T0,
        reason: 'r',
        boundary: 'b',
        expected_version: k.stateVersion,
      }).ok,
    ).toBe(true);
  });

  it('completion is refused while a blocking hold is active, then succeeds', () => {
    const { k, human } = seedKernel();
    k.registerHold({
      actor: human,
      at: T0,
      kind: 'bug',
      severity: 'critical',
      statement: 's',
      blocks_delivery: true,
      expected_version: 0,
    });
    expectErr(
      k.setProjectStatus({
        actor: human,
        at: T0,
        reason: 'done?',
        to: 'completed',
        expected_version: 0,
      }),
      'blocking-hold',
    );
    const holdId = firstKey(k.projection.holds);
    expect(
      k.transitionHold({
        actor: human,
        at: T0,
        hold_id: holdId,
        to: 'resolved',
        expected_version: 0,
      }).ok,
    ).toBe(true);
    expect(
      k.setProjectStatus({
        actor: human,
        at: T0,
        reason: 'done',
        to: 'completed',
        expected_version: 0,
      }).ok,
    ).toBe(true);
    expect(k.projection.project?.status).toBe('completed');
    expect(k.stateVersion).toBe(1);
  });

  it('archive cancels incomplete works and invalidates open holds with the cause; terminal cannot restart', () => {
    const { k, human } = seedKernel();
    const workId = valueOf(
      k.createWork({ actor: human, at: T0, reason: 'r', title: 'w', expected_version: 0 }),
    ).id;
    k.registerHold({
      actor: human,
      at: T0,
      kind: 'bug',
      severity: 'high',
      statement: 's',
      expected_version: 0,
    });
    k.setProjectStatus({
      actor: human,
      at: T0,
      reason: 'end of line',
      to: 'archived',
      expected_version: 0,
    });
    expect(k.projection.works[workId]?.status).toBe('cancelled');
    expect(Object.values(k.projection.holds)[0]?.status).toBe('invalidated');
    const cause = k.events.find((e) => e.type === 'hold.invalidated');
    expect(cause?.data['reason']).toContain('project archive');
    expectErr(
      k.setProjectStatus({
        actor: human,
        at: T0,
        reason: 'nope',
        to: 'active',
        expected_version: k.stateVersion,
      }),
      'forbidden',
    );
    expectErr(
      k.updateBoundary({
        actor: human,
        at: T0,
        reason: 'r',
        boundary: 'b',
        expected_version: k.stateVersion,
      }),
      'project-not-active',
    );
  });

  it('agent cannot transition project status; blank reason rejected; nothing appended', () => {
    const { k, agent, human } = seedKernel();
    const seq = k.currentSeq;
    expectErr(
      k.setProjectStatus({ actor: agent, at: T0, reason: 'r', to: 'paused', expected_version: 0 }),
      'forbidden',
    );
    expectErr(
      k.setProjectStatus({ actor: human, at: T0, reason: '  ', to: 'paused', expected_version: 0 }),
      'rationale-required',
    );
    expect(k.currentSeq).toBe(seq);
  });
});

describe('kernel: equip/return contract', () => {
  it('verified_facts are exactly the project-scope active assets; scope isolation holds', () => {
    const { k, human, agent } = seedKernel();
    const inScope = activeAsset(k, human, T0);
    k.createAsset({
      actor: human,
      at: T0,
      kind: 'artifact',
      scope: 'task',
      content: { storage: 'inline' },
      expected_version: 0,
    });
    k.createAsset({
      actor: human,
      at: T0,
      kind: 'artifact',
      scope: 'participant',
      content: { storage: 'inline' },
      expected_version: 0,
    });
    k.registerHold({
      actor: agent,
      at: T0,
      kind: 'bug',
      severity: 'low',
      statement: 'agent worry',
      expected_version: 0,
    });
    const equip = valueOf(k.issueEquip({ actor: agent, at: T0, expected_version: 0 }));
    expect(equip.verified_facts).toEqual([inScope]);
    expect(equip.active_holds).toEqual([]); // agent hold not confirmed yet
    expect(equip.state_version).toBe(0);
  });

  it('budget overflow fails explicitly with a diagnostics event (fact count, length, budget)', () => {
    const { k, human } = seedKernel();
    // 1700 verified fact ids ≈ 1700×39 bytes ≈ 66.3 KiB > 64 KiB budget.
    for (let i = 0; i < 1700; i += 1) activeAsset(k, human, T0);
    const r = k.issueEquip({ actor: human, at: T0, expected_version: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('equip-budget-exceeded');
      expect(r.error.details).toMatchObject({ fact_count: 1700, budget: EQUIP_SIZE_BUDGET });
      expect(Number(r.error.details?.['serialized_length'])).toBeGreaterThan(EQUIP_SIZE_BUDGET);
    }
    const diag = k.events.find((e) => e.type === 'equip.budget_exceeded');
    expect(diag).toBeDefined();
    expect(diag?.data['fact_count']).toBe(1700);
  });

  it('stale return is rejected wholesale with zero pollution; current-version return absorbs', () => {
    const { k, human, agent } = seedKernel();
    const equipId = valueOf(k.issueEquip({ actor: agent, at: T0, expected_version: 0 })).id;
    k.updateBoundary({
      actor: human,
      at: T0,
      reason: 'pivot',
      boundary: 'b2',
      expected_version: 0,
    });
    const stale = k.submitReturn({
      actor: agent,
      at: T0,
      equip_id: equipId,
      candidates: [{ kind: 'artifact', content: { storage: 'inline', sha256: 'b'.repeat(64) } }],
      effects: [{ description: 'side effect' }],
      expected_version: 1,
    });
    expectErr(stale, 'version-conflict');
    expect(Object.keys(k.projection.assets)).toHaveLength(0);
    expect(Object.keys(k.projection.effects)).toHaveLength(0);
    expect(k.events.some((e) => e.type === 'return.rejected')).toBe(true);
    const fresh = valueOf(k.issueEquip({ actor: agent, at: T0, expected_version: 1 }));
    k.submitReturn({
      actor: agent,
      at: T0,
      equip_id: fresh.id,
      candidates: [{ kind: 'artifact' }],
      effects: [{ description: 'e1' }],
      expected_version: 1,
    });
    expect(Object.keys(k.projection.assets)).toHaveLength(1);
    expect(Object.values(k.projection.effects)[0]?.status).toBe('unknown');
  });
});

describe('kernel: hold confirmation chain (ai-proposes-human-enacts)', () => {
  it('agent hold does not block delivery until a human confirms it', () => {
    const { k, human, agent } = seedKernel();
    const assetId = activeAsset(k, human, T0);
    const holdId = valueOf(
      k.registerHold({
        actor: agent,
        at: T0,
        kind: 'bug',
        severity: 'critical',
        statement: 'worry',
        blocks_delivery: true,
        asset_refs: [assetId],
        expected_version: 0,
      }),
    ).id;
    expect(k.projection.holds[holdId]?.status).toBe('registered');
    expect(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: assetId,
        target_ref: 't1',
        target_type: 'staging',
        expected_version: 0,
      }).ok,
    ).toBe(true);
    expect(
      k.transitionHold({ actor: human, at: T0, hold_id: holdId, to: 'active', expected_version: 0 })
        .ok,
    ).toBe(true);
    expectErr(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: assetId,
        target_ref: 't2',
        target_type: 'staging',
        expected_version: 0,
      }),
      'blocking-hold',
    );
  });

  it('every hold event carries the acting participant id', () => {
    const { k, human, agent } = seedKernel();
    const holdId = valueOf(
      k.registerHold({
        actor: agent,
        at: T0,
        kind: 'bug',
        severity: 'high',
        statement: 'w',
        expected_version: 0,
      }),
    ).id;
    k.transitionHold({ actor: human, at: T0, hold_id: holdId, to: 'active', expected_version: 0 });
    k.transitionHold({ actor: human, at: T0, hold_id: holdId, to: 'dormant', expected_version: 0 });
    k.transitionHold({
      actor: human,
      at: T0,
      hold_id: holdId,
      to: 'active',
      reason: 'rollback',
      expected_version: 0,
    });
    const holdEvents = k.events.filter((e) => e.type.startsWith('hold.'));
    expect(holdEvents.length).toBe(4);
    for (const e of holdEvents) {
      expect(typeof e.data['actor']).toBe('string');
      expect((e.data['actor'] as string).length).toBeGreaterThan(0);
    }
  });

  it('agent reactivation is forbidden; reactivation without reason is rejected', () => {
    const { k, human, agent } = seedKernel();
    const holdId = valueOf(
      k.registerHold({
        actor: human,
        at: T0,
        kind: 'bug',
        severity: 'high',
        statement: 'w',
        expected_version: 0,
      }),
    ).id;
    k.transitionHold({ actor: human, at: T0, hold_id: holdId, to: 'dormant', expected_version: 0 });
    expectErr(
      k.transitionHold({
        actor: agent,
        at: T0,
        hold_id: holdId,
        to: 'active',
        reason: 'agent push',
        expected_version: 0,
      }),
      'forbidden',
    );
    expectErr(
      k.transitionHold({
        actor: human,
        at: T0,
        hold_id: holdId,
        to: 'active',
        expected_version: 0,
      }),
      'rationale-required',
    );
    expect(
      k.transitionHold({
        actor: human,
        at: T0,
        hold_id: holdId,
        to: 'active',
        reason: 'back',
        expected_version: 0,
      }).ok,
    ).toBe(true);
  });

  it('illegal hold transitions are rejected (registered→invalidated skips confirmation)', () => {
    const { k, human, agent } = seedKernel();
    // agent-registered hold starts `registered`; only the human confirmation leads out of it
    const holdId = valueOf(
      k.registerHold({
        actor: agent,
        at: T0,
        kind: 'bug',
        severity: 'high',
        statement: 'w',
        expected_version: 0,
      }),
    ).id;
    expectErr(
      k.transitionHold({
        actor: human,
        at: T0,
        hold_id: holdId,
        to: 'invalidated',
        expected_version: 0,
      }),
      'forbidden',
    );
    expectErr(
      k.transitionHold({
        actor: human,
        at: T0,
        hold_id: holdId,
        to: 'dormant',
        expected_version: 0,
      }),
      'forbidden',
    );
  });
});

describe('kernel: effect ledger + delivery gate order (T21)', () => {
  it('gate order: not-active → unaccepted → blocking-hold → unknown-effect', () => {
    const { k, human, agent } = seedKernel();
    k.setProjectStatus({ actor: human, at: T0, reason: 'rest', to: 'paused', expected_version: 0 });
    const created = k.createAsset({
      actor: human,
      at: T0,
      kind: 'artifact',
      scope: 'project',
      content: { storage: 'inline', sha256: 'c'.repeat(64) },
      expected_version: k.stateVersion,
    });
    const assetId = valueOf(created).id;
    // gate 1 wins over everything
    expectErr(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: assetId,
        target_ref: 't',
        target_type: 'staging',
        expected_version: k.stateVersion,
      }),
      'project-not-active',
    );
    k.setProjectStatus({
      actor: human,
      at: T0,
      reason: 'back',
      to: 'active',
      expected_version: k.stateVersion,
    });
    // gate 2: candidate artifact
    expectErr(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: assetId,
        target_ref: 't',
        target_type: 'staging',
        expected_version: k.stateVersion,
      }),
      'unaccepted-artifact',
    );
    k.acceptAsset({
      actor: human,
      at: T0,
      asset_id: assetId,
      result: 'accepted',
      criteria_snapshot: {},
      expected_version: k.stateVersion,
    });
    // gate 3: blocking hold
    const holdId = valueOf(
      k.registerHold({
        actor: human,
        at: T0,
        kind: 'bug',
        severity: 'critical',
        statement: 's',
        blocks_delivery: true,
        asset_refs: [assetId],
        expected_version: k.stateVersion,
      }),
    ).id;
    expectErr(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: assetId,
        target_ref: 't',
        target_type: 'staging',
        expected_version: k.stateVersion,
      }),
      'blocking-hold',
    );
    k.transitionHold({
      actor: human,
      at: T0,
      hold_id: holdId,
      to: 'resolved',
      expected_version: k.stateVersion,
    });
    // gate 4: unclosed unknown effect
    const effectId = valueOf(
      k.recordEffect({
        actor: agent,
        at: T0,
        asset_ref: assetId,
        expected_version: k.stateVersion,
      }),
    ).id;
    expectErr(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: assetId,
        target_ref: 't',
        target_type: 'staging',
        expected_version: k.stateVersion,
      }),
      'unknown-effect-unclosed',
    );
    // confirmed-as-failed closure unblocks: closure is not success
    k.closeEffect({
      actor: human,
      at: T0,
      effect_id: effectId,
      outcome: 'failed',
      expected_version: k.stateVersion,
    });
    const clean = k.deliver({
      actor: human,
      at: T0,
      asset_id: assetId,
      target_ref: 't',
      target_type: 'staging',
      expected_version: k.stateVersion,
    });
    expect(clean.ok).toBe(true);
    if (clean.ok) {
      expect(clean.value.delivered_by).toBe(human);
      expect(clean.value.attempt_no).toBe(1);
      expect(clean.value.version).toBe('c'.repeat(64));
    }
  });

  it('one open attempt per (asset, target): retry only after terminal confirmation', () => {
    const { k, human } = seedKernel();
    const assetId = activeAsset(k, human, T0);
    expect(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: assetId,
        target_ref: 't',
        target_type: 'staging',
        expected_version: 0,
      }).ok,
    ).toBe(true);
    expectErr(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: assetId,
        target_ref: 't',
        target_type: 'staging',
        expected_version: 0,
      }),
      'open-attempt-exists',
    );
    const deliveryId = firstKey(k.projection.deliveries);
    k.confirmDelivery({
      actor: human,
      at: T0,
      delivery_id: deliveryId,
      outcome: 'rejected',
      expected_version: 0,
    });
    const retry = k.deliver({
      actor: human,
      at: T0,
      asset_id: assetId,
      target_ref: 't',
      target_type: 'staging',
      expected_version: 0,
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.value.attempt_no).toBe(2);
  });

  it('acceptance is human-only on candidates; rejected requires a written rationale', () => {
    const { k, human, agent } = seedKernel();
    const assetId = valueOf(
      k.createAsset({
        actor: human,
        at: T0,
        kind: 'artifact',
        scope: 'project',
        expected_version: 0,
      }),
    ).id;
    expectErr(
      k.acceptAsset({
        actor: agent,
        at: T0,
        asset_id: assetId,
        result: 'accepted',
        criteria_snapshot: {},
        expected_version: 0,
      }),
      'forbidden',
    );
    expectErr(
      k.acceptAsset({
        actor: human,
        at: T0,
        asset_id: assetId,
        result: 'rejected',
        criteria_snapshot: {},
        expected_version: 0,
      }),
      'rationale-required',
    );
    k.acceptAsset({
      actor: human,
      at: T0,
      asset_id: assetId,
      result: 'rejected',
      rationale: 'bad work',
      criteria_snapshot: {},
      expected_version: 0,
    });
    expect(k.projection.assets[assetId]?.lifecycle).toBe('rejected');
  });
});

describe('kernel: replay identity (200 events) + project time', () => {
  it('a fresh kernel rebuilt from the same log is canonical-JSON identical (200 events)', () => {
    const { k, human, agent } = seedKernel();
    let at = 0;
    const nextAt = (): string => atDay(++at);
    for (let i = 0; i < 19; i += 1) {
      const assetId = valueOf(
        k.createAsset({
          actor: human,
          at: nextAt(),
          kind: 'artifact',
          scope: 'project',
          content: { storage: 'inline' },
          expected_version: k.stateVersion,
        }),
      ).id;
      const holdId = valueOf(
        k.registerHold({
          actor: human,
          at: nextAt(),
          kind: 'bug',
          severity: 'low',
          statement: `w${String(i)}`,
          asset_refs: [assetId],
          expected_version: k.stateVersion,
        }),
      ).id;
      k.transitionHold({
        actor: human,
        at: nextAt(),
        hold_id: holdId,
        to: 'dormant',
        expected_version: k.stateVersion,
      });
      k.recordEffect({
        actor: agent,
        at: nextAt(),
        asset_ref: assetId,
        expected_version: k.stateVersion,
      });
      k.createWork({
        actor: human,
        at: nextAt(),
        reason: `w${String(i)}`,
        title: `work ${String(i)}`,
        expected_version: k.stateVersion,
      });
    }
    k.updateBoundary({
      actor: human,
      at: nextAt(),
      reason: 'pivot',
      boundary: 'b',
      expected_version: k.stateVersion,
    });
    while (k.currentSeq < 199) {
      k.createAsset({
        actor: human,
        at: nextAt(),
        kind: 'evidence',
        scope: 'project',
        expected_version: k.stateVersion,
      });
    }
    k.updateBoundary({
      actor: human,
      at: nextAt(),
      reason: 'final',
      boundary: 'b2',
      expected_version: k.stateVersion,
    });
    expect(k.currentSeq).toBe(200);
    expect(k.stateVersion).toBe(2);

    const rebuilt = ProjectStateKernel.fromEvents(k.events);
    expect(canonicalJson(rebuilt.projection)).toBe(canonicalJson(k.projection));
    expect(rebuilt.stateVersion).toBe(k.stateVersion);
    expect(k.verifyIntegrity().ok).toBe(true);
  });

  it('project updated_at/updated_by are written only by the replay path', () => {
    const { k, human } = seedKernel();
    expect(k.projection.project?.updated_at).toBe(T0);
    expect(k.projection.project?.updated_by).toBe(human); // project.created actor
    k.updateBoundary({
      actor: human,
      at: '2026-02-01T00:00:00.000Z',
      reason: 'r',
      boundary: 'b',
      expected_version: k.stateVersion,
    });
    expect(k.projection.project?.updated_at).toBe('2026-02-01T00:00:00.000Z');
    expect(k.projection.project?.updated_by).toBe(human);
    const rebuilt = ProjectStateKernel.fromEvents(k.events);
    expect(canonicalJson(rebuilt.projection.project)).toBe(canonicalJson(k.projection.project));
  });
});

describe('kernel: lifecycle machine edge gates through the kernel', () => {
  it('competitive grace and purge double-condition bind the named constants', () => {
    expect(COMPETITIVE_GRACE_PERIOD_DAYS).toBe(90);
    const { k, human } = seedKernel();
    const assetId = valueOf(
      k.createAsset({
        actor: human,
        at: T0,
        kind: 'artifact',
        scope: 'project',
        expected_version: 0,
      }),
    ).id;
    // candidate→archived is illegal (must activate before retiring)
    const r = k.transitionAsset({
      actor: human,
      at: T0,
      asset_id: assetId,
      to: 'archived',
      expected_version: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('illegal-transition');
    k.transitionAsset({
      actor: human,
      at: T0,
      asset_id: assetId,
      to: 'active',
      expected_version: 0,
    });
    k.transitionAsset({
      actor: human,
      at: T0,
      asset_id: assetId,
      to: 'archived',
      expected_version: 0,
    });
    // archived→purged requires 180 days + double confirmation
    const noPurge = k.transitionAsset({
      actor: human,
      at: T0,
      asset_id: assetId,
      to: 'purged',
      double_confirmation: true,
      expected_version: 0,
    });
    expect(noPurge.ok).toBe(false);
    if (!noPurge.ok) expect(noPurge.error.code).toBe('purge-conditions-unmet');
    const purge = k.transitionAsset({
      actor: human,
      at: atDay(200),
      asset_id: assetId,
      to: 'purged',
      double_confirmation: true,
      expected_version: 0,
    });
    expect(purge.ok).toBe(true);
    // tombstone read-side: the purged asset vanishes from lookups and gates
    expect(k.projection.assets[assetId]?.deleted_at).toBe(atDay(200));
    expectErr(
      k.deliver({
        actor: human,
        at: atDay(201),
        asset_id: assetId,
        target_ref: 't',
        target_type: 'staging',
        expected_version: 0,
      }),
      'unaccepted-artifact',
    );
  });

  it('competitive_superseded rollback honors the grace window', () => {
    const { k, human } = seedKernel();
    const assetId = activeAsset(k, human, T0);
    k.transitionAsset({
      actor: human,
      at: T0,
      asset_id: assetId,
      to: 'competitive_superseded',
      expected_version: 0,
    });
    // within grace: rollback allowed
    expect(
      k.transitionAsset({
        actor: human,
        at: atDay(89),
        asset_id: assetId,
        to: 'active',
        expected_version: 0,
      }).ok,
    ).toBe(true);
    // supersede again, then let the 90-day window lapse before rolling back
    k.transitionAsset({
      actor: human,
      at: atDay(100),
      asset_id: assetId,
      to: 'competitive_superseded',
      expected_version: 0,
    });
    const late = k.transitionAsset({
      actor: human,
      at: atDay(200),
      asset_id: assetId,
      to: 'active',
      expected_version: 0,
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe('illegal-transition');
  });
});

describe('kernel: event envelope schema_version', () => {
  it('every appended event carries schema_version 1', () => {
    const { k, human } = seedKernel();
    k.createAsset({
      actor: human,
      at: T0,
      kind: 'artifact',
      scope: 'project',
      expected_version: 0,
    });
    for (const e of k.events as StateEvent[]) expect(e.schema_version).toBe(1);
  });
});

describe('kernel: command guard matrix', () => {
  it('duplicate participant registration is forbidden; createProject conflicts on replay or stale version', () => {
    const { k, human } = seedKernel();
    expectErr(k.registerParticipant({ participant_id: human, type: 'human', at: T0 }), 'forbidden');
    expectErr(
      k.createProject({ actor: human, at: T0, title: 'again', expected_version: 0 }),
      'version-conflict',
    );
    expectErr(
      k.createProject({ actor: human, at: T0, title: 'fresh', expected_version: 5 }),
      'version-conflict',
    );
  });

  it('update_boundary no-op (neither boundary nor criteria) is forbidden', () => {
    const { k, human } = seedKernel();
    const r = k.updateBoundary({ actor: human, at: T0, reason: 'r', expected_version: 0 });
    expectErr(r, 'forbidden');
  });

  it('acceptance-criteria structure changes ride boundary events and are State-material', () => {
    const { k, human, agent } = seedKernel();
    const r = k.updateBoundary({
      actor: human,
      at: T0,
      reason: 'tighten the bar',
      acceptance_criteria: ['criteria-a', 'criteria-b'],
      expected_version: 0,
    });
    expect(r.ok).toBe(true);
    expect(k.stateVersion).toBe(1);
    expect(k.projection.project?.acceptance_criteria).toEqual(['criteria-a', 'criteria-b']);
    // the next equip snapshot carries the criteria (spec: equip payload)
    const equip = valueOf(k.issueEquip({ actor: agent, at: T0, expected_version: 1 }));
    expect(equip.acceptance_criteria).toEqual(['criteria-a', 'criteria-b']);
  });

  it('status commands before creation conflict; paused project can be archived', () => {
    const fresh = new ProjectStateKernel();
    fresh.registerParticipant({ participant_id: 'h0', type: 'human', at: T0 });
    expectErr(
      fresh.setProjectStatus({
        actor: 'h0',
        at: T0,
        reason: 'r',
        to: 'paused',
        expected_version: 0,
      }),
      'version-conflict',
    );
    const { k, human } = seedKernel();
    k.setProjectStatus({ actor: human, at: T0, reason: 'rest', to: 'paused', expected_version: 0 });
    expect(
      k.setProjectStatus({
        actor: human,
        at: T0,
        reason: 'fold',
        to: 'archived',
        expected_version: k.stateVersion,
      }).ok,
    ).toBe(true);
  });

  it('archive leaves completed works and closed holds untouched', () => {
    const { k, human } = seedKernel();
    const w1 = valueOf(
      k.createWork({ actor: human, at: T0, reason: 'r', title: 'w1', expected_version: 0 }),
    ).id;
    const w2 = valueOf(
      k.createWork({
        actor: human,
        at: T0,
        reason: 'r',
        title: 'w2',
        direction: 'd',
        expected_version: 0,
      }),
    ).id;
    k.cancelWork({
      actor: human,
      at: T0,
      reason: 'no longer needed',
      work_id: w2,
      expected_version: 0,
    });
    const hOpen = valueOf(
      k.registerHold({
        actor: human,
        at: T0,
        kind: 'bug',
        severity: 'high',
        statement: 'open',
        expected_version: 0,
      }),
    ).id;
    const hClosed = valueOf(
      k.registerHold({
        actor: human,
        at: T0,
        kind: 'bug',
        severity: 'low',
        statement: 'closed',
        expected_version: 0,
      }),
    ).id;
    k.transitionHold({
      actor: human,
      at: T0,
      hold_id: hClosed,
      to: 'resolved',
      expected_version: 0,
    });
    k.setProjectStatus({
      actor: human,
      at: T0,
      reason: 'end',
      to: 'archived',
      expected_version: 0,
    });
    expect(k.projection.works[w1]?.status).toBe('cancelled');
    expect(k.projection.works[w2]?.status).toBe('cancelled'); // already terminal: no second closure event
    expect(k.projection.holds[hOpen]?.status).toBe('invalidated');
    expect(k.projection.holds[hClosed]?.status).toBe('resolved'); // closed holds are history, not state
    const closures = k.events.filter(
      (e) => e.type === 'work.status_changed' && e.data['cause'] === 'project_archived',
    );
    expect(closures).toHaveLength(1);
  });

  it('cancel_work covers the lifecycle guard: happy, not-found, already-terminal', () => {
    const { k, human } = seedKernel();
    expectErr(
      k.cancelWork({ actor: human, at: T0, reason: 'r', work_id: 'missing', expected_version: 0 }),
      'forbidden',
    );
    const w = valueOf(
      k.createWork({ actor: human, at: T0, reason: 'r', title: 'w', expected_version: 0 }),
    ).id;
    const cancelled = k.cancelWork({
      actor: human,
      at: T0,
      reason: 'drop it',
      work_id: w,
      expected_version: 0,
    });
    expect(cancelled.ok).toBe(true);
    expect(k.projection.works[w]?.status).toBe('cancelled');
    expectErr(
      k.cancelWork({ actor: human, at: T0, reason: 'again', work_id: w, expected_version: 0 }),
      'forbidden',
    );
  });

  it('redirect_work rejects unknown works; checkpoint creation is optional', () => {
    const { k, human } = seedKernel();
    expectErr(
      k.redirectWork({
        actor: human,
        at: T0,
        reason: 'r',
        work_id: 'missing',
        direction: 'd',
        expected_version: 0,
      }),
      'forbidden',
    );
    const w = valueOf(
      k.createWork({ actor: human, at: T0, reason: 'r', title: 'w', expected_version: 0 }),
    ).id;
    const r = k.redirectWork({
      actor: human,
      at: T0,
      reason: 'method fix',
      work_id: w,
      direction: 'd2',
      create_checkpoint: false,
      expected_version: 0,
    });
    expect(r.ok).toBe(true);
    expect(Object.keys(k.projection.checkpoints)).toHaveLength(0);
  });

  it('asset commands reject unknown ids and non-candidates', () => {
    const { k, human } = seedKernel();
    expectErr(
      k.transitionAsset({
        actor: human,
        at: T0,
        asset_id: 'missing',
        to: 'active',
        expected_version: 0,
      }),
      'forbidden',
    );
    expectErr(
      k.acceptAsset({
        actor: human,
        at: T0,
        asset_id: 'missing',
        result: 'accepted',
        criteria_snapshot: {},
        expected_version: 0,
      }),
      'forbidden',
    );
    const a = valueOf(
      k.createAsset({
        actor: human,
        at: T0,
        kind: 'artifact',
        scope: 'project',
        expected_version: 0,
      }),
    ).id;
    k.transitionAsset({ actor: human, at: T0, asset_id: a, to: 'active', expected_version: 0 });
    expectErr(
      k.acceptAsset({
        actor: human,
        at: T0,
        asset_id: a,
        result: 'accepted',
        criteria_snapshot: {},
        expected_version: 0,
      }),
      'forbidden',
    );
  });

  it('hold commands reject blank statements and unknown ids; effects reject unknown or closed ids', () => {
    const { k, human, agent } = seedKernel();
    expectErr(
      k.registerHold({
        actor: human,
        at: T0,
        kind: 'bug',
        severity: 'high',
        statement: '  ',
        expected_version: 0,
      }),
      'rationale-required',
    );
    expectErr(
      k.transitionHold({
        actor: human,
        at: T0,
        hold_id: 'missing',
        to: 'active',
        reason: 'r',
        expected_version: 0,
      }),
      'forbidden',
    );
    expectErr(
      k.closeEffect({
        actor: human,
        at: T0,
        effect_id: 'missing',
        outcome: 'failed',
        expected_version: 0,
      }),
      'forbidden',
    );
    const assetId = activeAsset(k, human, T0);
    const effectId = valueOf(
      k.recordEffect({ actor: agent, at: T0, asset_ref: assetId, expected_version: 0 }),
    ).id;
    k.closeEffect({
      actor: human,
      at: T0,
      effect_id: effectId,
      outcome: 'confirmed',
      expected_version: 0,
    });
    expectErr(
      k.closeEffect({
        actor: human,
        at: T0,
        effect_id: effectId,
        outcome: 'failed',
        expected_version: 0,
      }),
      'forbidden',
    );
  });

  it('equip payload carries the current boundary and criteria; delivery requires content sha256', () => {
    const { k, human, agent } = seedKernel();
    k.updateBoundary({
      actor: human,
      at: T0,
      reason: 'scope',
      boundary: 'b1',
      acceptance_criteria: ['c1'],
      expected_version: 0,
    });
    const equip = valueOf(k.issueEquip({ actor: agent, at: T0, expected_version: 1 }));
    expect(equip.boundary).toBe('b1');
    const noContent = valueOf(
      k.createAsset({
        actor: human,
        at: T0,
        kind: 'artifact',
        scope: 'project',
        expected_version: 1,
      }),
    ).id;
    k.acceptAsset({
      actor: human,
      at: T0,
      asset_id: noContent,
      result: 'accepted',
      criteria_snapshot: {},
      expected_version: 1,
    });
    expectErr(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: noContent,
        target_ref: 't',
        target_type: 'staging',
        expected_version: 1,
      }),
      'forbidden',
    );
  });

  it('confirm_delivery rejects unknown and already-terminal deliveries; unknown actors are refused everywhere', () => {
    const { k, human, agent } = seedKernel();
    expectErr(k.issueEquip({ actor: 'ghost', at: T0, expected_version: 0 }), 'forbidden');
    const assetId = activeAsset(k, human, T0);
    const deliveryId = valueOf(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: assetId,
        target_ref: 't',
        target_type: 'staging',
        expected_version: 0,
      }),
    ).id;
    expectErr(
      k.confirmDelivery({
        actor: human,
        at: T0,
        delivery_id: 'missing',
        outcome: 'confirmed',
        expected_version: 0,
      }),
      'forbidden',
    );
    k.confirmDelivery({
      actor: human,
      at: T0,
      delivery_id: deliveryId,
      outcome: 'confirmed',
      expected_version: 0,
    });
    expectErr(
      k.confirmDelivery({
        actor: human,
        at: T0,
        delivery_id: deliveryId,
        outcome: 'rejected',
        expected_version: 0,
      }),
      'forbidden',
    );
    expect(Object.values(k.projection.deliveries)[0]?.confirmation_status).toBe('confirmed');
    expect(agent).toBeDefined();
  });

  it('a corrupt log (dangling replay reference) throws on rebuild', () => {
    const { k } = seedKernel();
    const last = k.events[k.events.length - 1];
    const bad = [
      ...k.events,
      {
        ...last,
        seq: 4,
        type: 'work.redirected',
        data: { work_id: 'ghost-work', direction: 'd' },
      } as StateEvent,
    ];
    expect(() => ProjectStateKernel.fromEvents(bad as never)).toThrow(/missing work/);
  });

  it('a gapped log fails verifyIntegrity through the history probe (white-box: storage seam)', () => {
    const { k } = seedKernel();
    const gapped = ProjectStateKernel.fromEvents(k.events);
    // The storage layer (4.3) will hand the kernel externally-loaded rows;
    // the probe exists for exactly that seam, so reach it through it.
    const seam = gapped as unknown as { history: { events: StateEvent[] } };
    seam.history.events = seam.history.events.filter((e) => e.seq !== 2);
    const probe = gapped.verifyIntegrity();
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.reason).toContain('seq violation');
  });
});

describe('kernel: guard-first failures and replay-exotic events', () => {
  it('every command refuses a ghost actor before any state check', () => {
    const { k, human } = seedKernel();
    const ghost = 'ghost';
    const w = valueOf(
      k.createWork({ actor: human, at: T0, reason: 'r', title: 'w', expected_version: 0 }),
    ).id;
    const a = valueOf(
      k.createAsset({
        actor: human,
        at: T0,
        kind: 'artifact',
        scope: 'project',
        expected_version: 0,
      }),
    ).id;
    const h = valueOf(
      k.registerHold({
        actor: human,
        at: T0,
        kind: 'bug',
        severity: 'high',
        statement: 's',
        expected_version: 0,
      }),
    ).id;
    expectErr(
      k.createWork({ actor: ghost, at: T0, reason: 'r', title: 'x', expected_version: 0 }),
      'forbidden',
    );
    expectErr(
      k.cancelWork({ actor: ghost, at: T0, reason: 'r', work_id: w, expected_version: 0 }),
      'forbidden',
    );
    expectErr(
      k.redirectWork({
        actor: ghost,
        at: T0,
        reason: 'r',
        work_id: w,
        direction: 'd',
        expected_version: 0,
      }),
      'forbidden',
    );
    expectErr(
      k.transitionAsset({ actor: ghost, at: T0, asset_id: a, to: 'active', expected_version: 0 }),
      'forbidden',
    );
    expectErr(
      k.registerHold({
        actor: ghost,
        at: T0,
        kind: 'bug',
        severity: 'high',
        statement: 's',
        expected_version: 0,
      }),
      'forbidden',
    );
    expectErr(
      k.transitionHold({
        actor: ghost,
        at: T0,
        hold_id: h,
        to: 'active',
        reason: 'r',
        expected_version: 0,
      }),
      'forbidden',
    );
    expectErr(
      k.recordEffect({ actor: ghost, at: T0, asset_ref: a, expected_version: 0 }),
      'forbidden',
    );
    expectErr(
      k.closeEffect({
        actor: ghost,
        at: T0,
        effect_id: 'e',
        outcome: 'failed',
        expected_version: 0,
      }),
      'forbidden',
    );
    expectErr(
      k.confirmDelivery({
        actor: ghost,
        at: T0,
        delivery_id: 'd',
        outcome: 'confirmed',
        expected_version: 0,
      }),
      'forbidden',
    );
    expectErr(
      k.setProjectStatus({ actor: ghost, at: T0, reason: 'r', to: 'paused', expected_version: 0 }),
      'forbidden',
    );
    expectErr(
      k.acceptAsset({
        actor: ghost,
        at: T0,
        asset_id: a,
        result: 'accepted',
        criteria_snapshot: {},
        expected_version: 0,
      }),
      'forbidden',
    );
  });

  it('issueEquip snapshots active holds when one is confirmed (post-creation rows also get timestamps)', () => {
    const { k, human, agent } = seedKernel();
    const assetId = activeAsset(k, human, T0);
    const h = valueOf(
      k.registerHold({
        actor: human,
        at: T0,
        kind: 'bug',
        severity: 'high',
        statement: 'live',
        asset_refs: [assetId],
        expected_version: 0,
      }),
    ).id;
    expect(k.projection.holds[h]?.status).toBe('active'); // human registration is active immediately
    const equip = valueOf(k.issueEquip({ actor: agent, at: T0, expected_version: 0 }));
    expect(equip.active_holds).toEqual([h]);
  });

  it('replay folds exotic-but-valid events: no-op checkpoint and unknown types throw', () => {
    const { k } = seedKernel();
    const last = k.events[k.events.length - 1];
    // checkpoint.created is replayed as a no-op (storage-layer symmetry)
    const cpKernel = ProjectStateKernel.fromEvents([
      ...k.events,
      {
        ...last,
        seq: k.currentSeq + 1,
        type: 'checkpoint.created',
        data: { id: 'cp-x' },
      } as StateEvent,
    ]);
    expect(cpKernel.currentSeq).toBe(k.currentSeq + 1);
    // an unknown type must throw in replay, not silently vanish
    expect(() =>
      ProjectStateKernel.fromEvents([
        ...k.events,
        { ...last, seq: k.currentSeq + 1, type: 'future.unknown', data: {} } as StateEvent,
      ]),
    ).toThrow(/unknown event type/);
  });

  it('verifyIntegrity catches a tampered live projection', () => {
    const { k } = seedKernel();
    const seam = k as unknown as { draft: { project: { title: string } | null } };
    if (seam.draft.project) seam.draft.project.title = 'tampered';
    const probe = k.verifyIntegrity();
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.reason).toContain('diverges from replay');
  });

  it('append rejects an empty logical time', () => {
    const { k, human } = seedKernel();
    expect(() =>
      k.registerHold({
        actor: human,
        at: '  ',
        kind: 'bug',
        severity: 'low',
        statement: 's',
        expected_version: 0,
      }),
    ).toThrow(/missing logical time/);
  });
});

describe('kernel: optional-field matrix', () => {
  it('carries every optional command field into events, projection, and replay', () => {
    const k = new ProjectStateKernel();
    const human = 'h1-full';
    const agent = 'a1-full';
    k.registerParticipant({ participant_id: human, type: 'human', at: T0, display_name: 'Owner' });
    k.registerParticipant({ participant_id: agent, type: 'agent', at: T0 });
    const project = valueOf(
      k.createProject({
        actor: human,
        at: T0,
        title: 'full',
        purpose: 'why',
        boundary: 'b0',
        acceptance_criteria: ['c1'],
        expected_version: 0,
      }),
    );
    const a1 = valueOf(
      k.createAsset({
        actor: human,
        at: T0,
        kind: 'artifact',
        scope: 'project',
        project_id: project.id,
        provenance: 'p1',
        content: { storage: 'inline', sha256: 'd'.repeat(64) },
        expected_version: 0,
      }),
    ).id;
    expectErr(
      k.acceptAsset({
        actor: human,
        at: T0,
        asset_id: a1,
        result: 'conditional',
        criteria_snapshot: {},
        expected_version: 0,
      }),
      'rationale-required',
    );
    k.acceptAsset({
      actor: human,
      at: T0,
      asset_id: a1,
      result: 'conditional',
      rationale: 'mostly there',
      criteria_snapshot: { rule: 'r' },
      evidence_refs: ['e1'],
      expected_version: 0,
    });
    const a2 = valueOf(
      k.createAsset({
        actor: human,
        at: T0,
        kind: 'artifact',
        scope: 'project',
        content: { storage: 'inline', sha256: 'e'.repeat(64) },
        expected_version: 0,
      }),
    ).id;
    k.acceptAsset({
      actor: human,
      at: T0,
      asset_id: a2,
      result: 'accepted',
      criteria_snapshot: {},
      expected_version: 0,
    });
    const h = valueOf(
      k.registerHold({
        actor: agent,
        at: T0,
        kind: 'bug',
        severity: 'high',
        statement: 's',
        blocks_delivery: true,
        asset_refs: [a2],
        expected_version: 0,
      }),
    ).id;
    k.transitionHold({
      actor: human,
      at: T0,
      hold_id: h,
      to: 'active',
      reason: 'confirmed',
      expected_version: 0,
    });
    const ef = valueOf(
      k.recordEffect({
        actor: agent,
        at: T0,
        asset_ref: a2,
        description: 'side effect',
        expected_version: 0,
      }),
    ).id;
    k.closeEffect({
      actor: human,
      at: T0,
      effect_id: ef,
      outcome: 'confirmed',
      reason: 'verified',
      expected_version: 0,
    });
    const w = valueOf(
      k.createWork({ actor: human, at: T0, reason: 'r', title: 'w', expected_version: 0 }),
    ).id;
    const equip = valueOf(
      k.issueEquip({
        actor: agent,
        at: T0,
        work_id: w,
        participant_id: agent,
        allowed_actions: ['read', 'write'],
        expected_version: 0,
      }),
    );
    const issuedEvent = k.events.find((e) => e.type === 'equip.issued');
    expect(issuedEvent?.data['allowed_actions']).toEqual(['read', 'write']);
    k.submitReturn({
      actor: agent,
      at: T0,
      equip_id: equip.id,
      candidates: [{ kind: 'artifact', provenance: 'p2', content: { storage: 'inline' } }],
      effects: [{ asset_ref: a1, description: 'd1' }],
      expected_version: 0,
    });
    const equip2 = valueOf(k.issueEquip({ actor: agent, at: T0, expected_version: 0 }));
    k.submitReturn({ actor: agent, at: T0, equip_id: equip2.id, expected_version: 0 });
    // minimal effect seed (no description) and description-less recordEffect
    const equip2b = valueOf(k.issueEquip({ actor: agent, at: T0, expected_version: 0 }));
    k.submitReturn({
      actor: agent,
      at: T0,
      equip_id: equip2b.id,
      effects: [{ asset_ref: a1 }],
      expected_version: 0,
    });
    valueOf(
      k.recordEffect({
        actor: agent,
        at: T0,
        description: 'orphan observation',
        expected_version: 0,
      }),
    );
    expectErr(
      k.submitReturn({ actor: agent, at: T0, equip_id: 'no-such', expected_version: 0 }),
      'version-conflict',
    );
    expectErr(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: 'no-such',
        target_ref: 't',
        target_type: 'staging',
        expected_version: 0,
      }),
      'unaccepted-artifact',
    );
    expectErr(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: a2,
        target_ref: 't',
        target_type: 'staging',
        expected_version: 0,
      }),
      'blocking-hold',
    );
    k.transitionHold({ actor: human, at: T0, hold_id: h, to: 'resolved', expected_version: 0 });
    const d1 = valueOf(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: a2,
        target_ref: 't',
        target_type: 'staging',
        expected_version: 0,
      }),
    );
    k.confirmDelivery({
      actor: human,
      at: T0,
      delivery_id: d1.id,
      outcome: 'confirmed',
      feedback: 'good',
      expected_version: 0,
    });
    // unscoped blocking hold (no asset_refs) does not block asset-scoped deliveries
    k.registerHold({
      actor: human,
      at: T0,
      kind: 'bug',
      severity: 'high',
      statement: 'unscoped',
      blocks_delivery: true,
      expected_version: 0,
    });
    const a3 = valueOf(
      k.createAsset({
        actor: human,
        at: T0,
        kind: 'artifact',
        scope: 'project',
        content: { storage: 'inline', sha256: 'f'.repeat(64) },
        expected_version: 0,
      }),
    ).id;
    k.acceptAsset({
      actor: human,
      at: T0,
      asset_id: a3,
      result: 'accepted',
      criteria_snapshot: {},
      expected_version: 0,
    });
    expect(
      k.deliver({
        actor: human,
        at: T0,
        asset_id: a3,
        target_ref: 't',
        target_type: 'staging',
        expected_version: 0,
      }).ok,
    ).toBe(true);
    // purge gate on a never-archived asset (daysArchived fallback) and without confirmation
    const a4 = valueOf(
      k.createAsset({
        actor: human,
        at: T0,
        kind: 'artifact',
        scope: 'project',
        expected_version: 0,
      }),
    ).id;
    k.transitionAsset({ actor: human, at: T0, asset_id: a4, to: 'active', expected_version: 0 });
    expect(
      k.transitionAsset({ actor: human, at: T0, asset_id: a4, to: 'purged', expected_version: 0 })
        .ok,
    ).toBe(false);
    expectErr(
      k.setProjectStatus({ actor: human, at: T0, reason: 'r', to: 'paused', expected_version: 9 }),
      'version-conflict',
    );
    // second boundary pass over an already-stale equip exercises the skip arm
    const eq3 = valueOf(k.issueEquip({ actor: agent, at: T0, expected_version: k.stateVersion }));
    const v1 = k.stateVersion;
    k.updateBoundary({ actor: human, at: T0, reason: 'r1', boundary: 'b1', expected_version: v1 });
    k.updateBoundary({
      actor: human,
      at: T0,
      reason: 'r2',
      boundary: 'b2',
      expected_version: v1 + 1,
    });
    expect(k.projection.equips[eq3.id]?.status).toBe('stale');
  });

  it('commands before creation conflict through the shared guard', () => {
    const fresh = new ProjectStateKernel();
    fresh.registerParticipant({ participant_id: 'h0', type: 'human', at: T0 });
    expectErr(
      fresh.createWork({ actor: 'h0', at: T0, reason: 'r', title: 'w', expected_version: 0 }),
      'version-conflict',
    );
  });

  it('replay tolerates system (null-actor) row touches', () => {
    const { k, human } = seedKernel();
    const w = valueOf(
      k.createWork({ actor: human, at: T0, reason: 'r', title: 'w', expected_version: 0 }),
    ).id;
    const last = k.events[k.events.length - 1];
    const rebuilt = ProjectStateKernel.fromEvents([
      ...k.events,
      {
        ...last,
        seq: k.currentSeq + 1,
        type: 'work.status_changed',
        actor: null,
        data: { work_id: w, from: 'planned', to: 'cancelled', reason: 'system', cause: 'system' },
      } as StateEvent,
    ]);
    expect(rebuilt.projection.works[w]?.status).toBe('cancelled');
    expect(rebuilt.projection.works[w]?.updated_by).toBeNull();
  });
});
