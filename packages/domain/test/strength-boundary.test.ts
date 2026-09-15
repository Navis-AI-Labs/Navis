import { describe, expect, it } from 'vitest';
import { ProjectStateKernel, type KernelResult } from '../src/state/project-state-kernel.js';
import {
  computeStrength,
  shapeSuggestion,
  NEUTRAL_BASELINE,
  SUGGESTION_THRESHOLD,
} from '../src/state/strength.js';

const T0 = '2026-06-01T00:00:00.000Z';
const atDay = (n: number): string => new Date(Date.parse(T0) + n * 86_400_000).toISOString();
const HUMAN = '01900000-0000-7000-8000-000000000001';

function must<T>(result: KernelResult<T>): T {
  if (!result.ok) throw new Error('strength fixture: ' + result.error.code);
  return result.value;
}

function fixture(withReference = true): { k: ProjectStateKernel; assetId: string } {
  const k = new ProjectStateKernel();
  must(k.registerParticipant({ participant_id: HUMAN, type: 'human', at: T0 }));
  const project = must(
    k.createProject({ actor: HUMAN, at: T0, title: 'retention', expected_version: 0 }),
  );
  const asset = must(
    k.createAsset({
      actor: HUMAN,
      at: T0,
      kind: withReference ? 'artifact' : 'knowledge',
      scope: 'project',
      project_id: project.id,
      content: { media_type: 'text/plain', storage: 'inline', sha256: 'a'.repeat(64) },
      expected_version: 0,
    }),
  );
  must(
    k.acceptAsset({
      actor: HUMAN,
      at: T0,
      asset_id: asset.id,
      result: 'accepted',
      criteria_snapshot: { rule: 'verified' },
      expected_version: 0,
    }),
  );
  for (let n = 1; n <= 3; n++) {
    const work = must(
      k.createWork({
        actor: HUMAN,
        at: atDay(n),
        title: 'work ' + String(n),
        reason: 'continue',
        expected_version: 0,
      }),
    );
    const equip = must(
      k.issueEquip({ actor: HUMAN, at: atDay(n), work_id: work.id, expected_version: 0 }),
    );
    expect(equip.verified_facts).toContain(asset.id);
  }
  if (withReference) {
    must(
      k.deliver({
        actor: HUMAN,
        at: atDay(4),
        asset_id: asset.id,
        target_ref: 'initial',
        target_type: 'staging',
        expected_version: 0,
      }),
    );
  }
  must(
    k.createWork({
      actor: HUMAN,
      at: atDay(100),
      title: 'later work',
      reason: 'continue',
      expected_version: 0,
    }),
  );
  return { k, assetId: asset.id };
}

function evaluate(k: ProjectStateKernel, assetId: string) {
  const p = k.projection;
  const asset = p.assets[assetId];
  const head = k.events.at(-1);
  if (asset === undefined || head === undefined) throw new Error('strength fixture missing state');
  return computeStrength({
    asset,
    acceptances: p.acceptances,
    deliveries: p.deliveries,
    holds: p.holds,
    works: p.works,
    evaluationAt: head.at,
  });
}

describe('strength over real kernel state', () => {
  it('shapes a stale-reference suggestion without changing state or history', () => {
    const { k, assetId } = fixture();
    const before = k.projection;
    const events = k.events;
    const result = evaluate(k, assetId);
    expect(result.score).toBeLessThan(SUGGESTION_THRESHOLD);
    expect(result.signals.edge_count).toBe(1);
    expect(shapeSuggestion(result, 'active')?.requires_confirmation).toBe(true);
    expect(k.projection).toEqual(before);
    expect(k.events).toEqual(events);
    expect(k.verifyIntegrity().ok).toBe(true);
    expect(Object.hasOwn(k.projection.assets[assetId] ?? {}, 'strength')).toBe(false);
  });

  it('executes a suggestion only through the human reason-gated command', () => {
    const { k, assetId } = fixture();
    const before = k.currentSeq;
    const rejected = k.transitionAsset({
      actor: HUMAN,
      at: atDay(100),
      asset_id: assetId,
      to: 'deprecated',
      reason: ' ',
      expected_version: 0,
    });
    expect(rejected.ok).toBe(false);
    expect(k.currentSeq).toBe(before);
    must(
      k.transitionAsset({
        actor: HUMAN,
        at: atDay(100),
        asset_id: assetId,
        to: 'deprecated',
        reason: 'reviewed retention evidence',
        expected_version: 0,
      }),
    );
    expect(k.currentSeq).toBe(before + 1);
  });

  it('keeps the accepted verdict valid at low strength', () => {
    const { k, assetId } = fixture();
    expect(evaluate(k, assetId).score).toBeLessThan(SUGGESTION_THRESHOLD);
    expect(
      Object.values(k.projection.acceptances).filter(
        (a) => a.asset_id === assetId && a.result === 'accepted',
      ),
    ).toHaveLength(1);
    expect(k.projection.assets[assetId]?.lifecycle).toBe('active');
  });

  it('does not reactivate a superseded asset even at high strength', () => {
    const { k, assetId } = fixture();
    must(
      k.deliver({
        actor: HUMAN,
        at: atDay(100),
        asset_id: assetId,
        target_ref: 'recent',
        target_type: 'staging',
        expected_version: 0,
      }),
    );
    must(
      k.transitionAsset({
        actor: HUMAN,
        at: atDay(100),
        asset_id: assetId,
        to: 'superseded',
        reason: 'new artifact accepted',
        expected_version: 0,
      }),
    );
    const result = evaluate(k, assetId);
    expect(result.score).toBeGreaterThan(SUGGESTION_THRESHOLD);
    expect(shapeSuggestion(result, 'superseded')).toBeNull();
    expect(k.projection.assets[assetId]?.lifecycle).toBe('superseded');
  });

  it('keeps repeatedly equipped knowledge neutral when usage edges are unobserved', () => {
    const { k, assetId } = fixture(false);
    const result = evaluate(k, assetId);
    expect(result.signals.observed_works).toBe(4);
    expect(result.signals.edge_count).toBe(0);
    expect(result.score).toBe(NEUTRAL_BASELINE);
    expect(shapeSuggestion(result, 'active')).toBeNull();
  });
});
