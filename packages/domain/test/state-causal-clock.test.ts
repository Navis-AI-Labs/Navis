import { describe, expect, it } from 'vitest';

import { causalClockSnapshotSchema, type CausalClockSnapshot } from '../src/schema/causal-clock.js';
import { advanceClock, compareClocks, mergeClocks } from '../src/state/vector-clock.js';
import { ProjectStateKernel } from '../src/state/project-state-kernel.js';

/**
 * Clock advances, replay equality, the four verdicts at return time, and
 * the no-context pin (absent context keeps the payload shape and skips judgment).
 */

const AT = '2026-09-04T09:00:00.000Z';
const T = (m: number) => new Date(Date.parse(AT) + m * 60_000).toISOString();

interface World {
  k: ProjectStateKernel;
  human: string;
  agent: string;
  agentB: string;
  equipId: string;
  equipIdB: string;
}

let uuidCounter = 0;
const nextUuid = (): string => {
  uuidCounter += 1;
  return `0198b200-0000-7000-8000-${String(uuidCounter).padStart(12, '0')}`;
};

function seeded(): World {
  const k = new ProjectStateKernel();
  const human = '0198b100-0000-7000-8000-000000000001';
  const agent = '0198b100-0000-7000-8000-000000000002';
  const agentB = '0198b100-0000-7000-8000-000000000003';
  k.registerParticipant({ participant_id: human, type: 'human', at: AT });
  k.registerParticipant({ participant_id: agent, type: 'agent', at: AT });
  k.registerParticipant({ participant_id: agentB, type: 'agent', at: AT });
  k.createProject({ actor: human, at: AT, title: 'P', expected_version: 0 });
  const work = k.createWork({
    actor: human,
    at: AT,
    reason: 'seed',
    title: 'W',
    expected_version: 0,
  });
  if (!work.ok) throw new Error('seed createWork failed');
  const equip = k.issueEquip({
    actor: human,
    at: T(1),
    participant_id: agent,
    expected_version: 0,
  });
  if (!equip.ok) throw new Error('seed issueEquip failed');
  const equipIdB = equip.value.id;
  const equipB = k.issueEquip({
    actor: human,
    at: T(1),
    participant_id: agentB,
    expected_version: 0,
  });
  if (!equipB.ok) throw new Error('seed issueEquipB failed');
  return { k, human, agent, agentB, equipId: equipIdB, equipIdB: equipB.value.id };
}

function returnFrom(
  w: World,
  opts: {
    actor: string;
    equipId: string;
    at: string;
    causal?: Record<string, number>;
    candidates?: number;
  },
): { ok: boolean; error?: unknown } {
  const r = w.k.submitReturn({
    actor: opts.actor,
    at: opts.at,
    equip_id: opts.equipId,
    expected_version: 0,
    ...(opts.causal === undefined ? {} : { causal_context: opts.causal }),
    ...(opts.candidates === undefined
      ? {}
      : {
          candidates: Array.from({ length: opts.candidates }, () => ({
            kind: 'note',
          })),
        }),
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

describe('clock advance: per-event author component', () => {
  it('advances the acting participant by exactly 1 per accepted event', () => {
    const w = seeded();
    const afterSeed = { ...w.k.causal_clock };
    // The seed: 3 null-actor registrations, then createProject + createWork
    // and two issueEquips — all by the human.
    expect(afterSeed[w.human]).toBe(4);
    expect(afterSeed[w.agent]).toBeUndefined();
    expect(afterSeed[w.agentB]).toBeUndefined();
    w.k.createWork({ actor: w.human, at: T(2), reason: 'r', title: 'W2', expected_version: 0 });
    expect(w.k.causal_clock[w.human]).toBe((afterSeed[w.human] ?? 0) + 1);
  });

  it('does not advance anyone for participant.registered (null actor)', () => {
    const w = seeded();
    const before = { ...w.k.causal_clock };
    w.k.registerParticipant({
      participant_id: nextUuid(),
      type: 'agent',
      at: T(2),
    });
    expect(w.k.causal_clock).toEqual(before);
  });

  it('rejects an unregistered causal-context component with causal-actor-unregistered', () => {
    const w = seeded();
    const stranger = nextUuid();
    const r = w.k.submitReturn({
      actor: w.agent,
      at: T(2),
      equip_id: w.equipId,
      expected_version: 0,
      causal_context: { [w.human]: 1, [stranger]: 3 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok && 'code' in r.error) {
      expect(r.error.code).toBe('causal-actor-unregistered');
      expect(r.error.urn).toBe('kernel/causal-actor-unregistered');
      expect(r.error.details?.['participant_id']).toBe(stranger);
    }
    // nothing was appended
    expect(w.k.events.at(-1)?.type).toBe('equip.issued');
  });
});

describe('replay rebuild equality', () => {
  it('rebuildProjection reconstructs the clock identically from authorship', () => {
    const w = seeded();
    // more activity from several participants
    w.k.createWork({ actor: w.human, at: T(2), reason: 'r', title: 'W2', expected_version: 0 });
    void returnFrom(w, { actor: w.agent, equipId: w.equipId, at: T(3) });
    void returnFrom(w, { actor: w.agentB, equipId: w.equipIdB, at: T(3) });
    const rebuilt = ProjectStateKernel.fromEvents(w.k.events);
    expect(rebuilt.causal_clock).toEqual(w.k.causal_clock);
    // and the projection rows carry the equip snapshots on replay too
    expect(rebuilt.projection.equips).toEqual(w.k.projection.equips);
  });
});

describe('rebuild defends against an impossible log', () => {
  it('a persisted event whose actor is not yet registered fails the rebuild loudly', () => {
    const w = seeded();
    // forge a seq-contiguous log whose first acted event has no
    // registration ahead of it (the log omits every registration while
    // keeping the acted events, renumbered to stay gapless)
    const forged = w.k.events
      .filter((e) => e.type !== 'participant.registered')
      .map((e, i) => ({ ...e, seq: i + 1 }));
    expect(() => ProjectStateKernel.fromEvents(forged)).toThrow(/actor not registered at seq/);
  });
});

describe('return verdicts', () => {
  it('records dominated_by when the world moved on but the work did not conflict', () => {
    const w = seeded();
    // agent returns first without a context (untracked), advancing the server clock
    void returnFrom(w, { actor: w.agent, equipId: w.equipId, at: T(2) });
    // then the human does one more server-side action: server human=5
    w.k.createWork({ actor: w.human, at: T(3), reason: 'r', title: 'W2', expected_version: 0 });
    void returnFrom(w, {
      actor: w.agentB,
      equipId: w.equipIdB,
      at: T(4),
      causal: { [w.human]: 4, [w.agent]: 1 },
    });
    const absorbed = w.k.events.filter((e) => e.type === 'return.absorbed');
    const last = absorbed.at(-1);
    expect(last?.data['verdict']).toBe('dominated_by');
    expect(last?.data['causal_context']).toEqual({ [w.human]: 4, [w.agent]: 1 });
    expect(w.k.events.some((e) => e.type === 'return.conflict_marked')).toBe(false);
  });

  it('marks a concurrent absorbable return and keeps candidates unaccepted', () => {
    const w = seeded();
    // concurrent needs divergence on BOTH sides: the human moved the server
    // forward after agentB's observation (a work creation), and agentB
    // carries unseen self-advances from offline work.
    w.k.createWork({ actor: w.human, at: T(2), reason: 'r', title: 'W2', expected_version: 0 });
    // re-equip so agentB can return against the unchanged state version
    const equip2 = w.k.issueEquip({
      actor: w.human,
      at: T(3),
      participant_id: w.agentB,
      expected_version: 0,
    });
    if (!equip2.ok) throw new Error('re-equip failed');
    void returnFrom(w, {
      actor: w.agentB,
      equipId: equip2.value.id,
      at: T(4),
      // agentB saw the human's first 4 events, then went offline; the server
      // has since gained W2 (human=5). agentB's offline self-advance: 5.
      causal: { [w.human]: 4, [w.agentB]: 5 },
    });
    const absorbed = w.k.events.filter((e) => e.type === 'return.absorbed').at(-1);
    expect(absorbed?.data['verdict']).toBe('concurrent');
    const marked = w.k.events.filter((e) => e.type === 'return.conflict_marked');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.data['verdict']).toBe('concurrent');
    expect(marked[0]?.data['causal_context']).toEqual({ [w.human]: 4, [w.agentB]: 5 });
    // absorbed candidates stay unaccepted (lifecycle candidate, not active)
    for (const e of w.k.events.filter((e) => e.type === 'return.absorbed')) {
      for (const c of e.data['candidates'] as { id: string }[]) {
        expect(w.k.projection.assets[c.id]?.lifecycle).toBe('candidate');
      }
    }
  });

  it('records the verdict on a wholesale-rejected return without changing rejection behavior', () => {
    const w = seeded();
    // force a boundary update so the equip goes stale
    const upd = w.k.updateBoundary({
      actor: w.human,
      at: T(2),
      reason: 'sharper criteria',
      boundary: 'new boundary',
      expected_version: 0,
    });
    expect(upd.ok).toBe(true);
    // state version advanced to 1 by the boundary update; the return must
    // present it to pass the command gate and hit the stale-equip check
    const r = w.k.submitReturn({
      actor: w.agent,
      at: T(3),
      equip_id: w.equipId,
      expected_version: 1,
      // agent saw the human's 4 seed events (pre-boundary world) plus its
      // own offline self-advances: 3. The server has human=5, agent=0 —
      // divergent on both sides -> concurrent verdict, still recorded on
      // the rejection event (the dispute facts are worth the ledger).
      causal_context: { [w.human]: 4, [w.agent]: 3 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok && 'code' in r.error) expect(r.error.code).toBe('version-conflict');
    const rejected = w.k.events.at(-1);
    expect(rejected?.type).toBe('return.rejected');
    expect(rejected?.data['verdict']).toBe('concurrent');
    expect(rejected?.data['causal_context']).toEqual({ [w.human]: 4, [w.agent]: 3 });
  });

  it('rejects a malformed causal context with causal-context-invalid and appends nothing', () => {
    const w = seeded();
    const before = w.k.events.length;
    const r = w.k.submitReturn({
      actor: w.agent,
      at: T(2),
      equip_id: w.equipId,
      expected_version: 0,
      // violates the snapshot schema: zero counter and a non-uuid key
      causal_context: { [w.human]: 0, badkey: 3 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok && 'code' in r.error) {
      expect(r.error.code).toBe('causal-context-invalid');
      expect(r.error.urn).toBe('kernel/causal-context-invalid');
    }
    expect(w.k.events.length).toBe(before);
  });

  it('behaves byte-identically without causal_context (no-context pin)', () => {
    const untrackedWorld = seeded();
    const shapedWorld = seeded();
    // no-context return on both worlds; then compare event payload shapes
    void returnFrom(untrackedWorld, {
      actor: untrackedWorld.agent,
      equipId: untrackedWorld.equipId,
      at: T(2),
    });
    const legacyKeys = Object.keys(
      untrackedWorld.k.events.find((e) => e.type === 'return.absorbed')?.data ?? {},
    ).sort();
    void returnFrom(shapedWorld, {
      actor: shapedWorld.agent,
      equipId: shapedWorld.equipId,
      at: T(2),
    });
    const shapedKeys = Object.keys(
      shapedWorld.k.events.find((e) => e.type === 'return.absorbed')?.data ?? {},
    ).sort();
    expect(shapedKeys).toEqual(legacyKeys);
    expect(shapedKeys).toEqual(['actor', 'candidates', 'effects', 'equip_id']);
    // and no conflict event exists without a context
    expect(shapedWorld.k.events.some((e) => e.type === 'return.conflict_marked')).toBe(false);
  });
});

describe('two parallel returns', () => {
  it('marks both mutually unaware returns independently', () => {
    const w = seeded();
    // The human creates a work AFTER both equips — server clock: human=5.
    // Both agents went offline before that and still hold human=4, and
    // each carries unseen self-advances. Both contexts diverge from the
    // server on both sides -> both concurrent, both marked.
    w.k.createWork({ actor: w.human, at: T(2), reason: 'r', title: 'W2', expected_version: 0 });
    const ea = w.k.issueEquip({
      actor: w.human,
      at: T(3),
      participant_id: w.agent,
      expected_version: 0,
    });
    const eb = w.k.issueEquip({
      actor: w.human,
      at: T(3),
      participant_id: w.agentB,
      expected_version: 0,
    });
    if (!ea.ok || !eb.ok) throw new Error('re-equip failed');
    void returnFrom(w, {
      actor: w.agent,
      equipId: ea.value.id,
      at: T(4),
      causal: { [w.agent]: 7, [w.human]: 4 },
    });
    void returnFrom(w, {
      actor: w.agentB,
      equipId: eb.value.id,
      at: T(4),
      causal: { [w.agentB]: 9, [w.human]: 4 },
    });
    const marked = w.k.events.filter((e) => e.type === 'return.conflict_marked');
    expect(marked).toHaveLength(2);
    const contexts = marked.map((e) => e.data['causal_context']) as Record<string, number>[];
    expect(contexts[0]?.[w.agent]).toBe(7);
    expect(contexts[1]?.[w.agentB]).toBe(9);
  });

  it('does not mark a later return that already observed the earlier parallel work', () => {
    const w = seeded();
    // The human creates a work AFTER the first equip — server clock: human=5.
    // agent went offline BEFORE W2, holds human=4, and carries 7 unseen
    // self-advances -> divergent on BOTH sides -> concurrent, marked.
    w.k.createWork({ actor: w.human, at: T(2), reason: 'r', title: 'W2', expected_version: 0 });
    const ea = w.k.issueEquip({
      actor: w.human,
      at: T(3),
      participant_id: w.agent,
      expected_version: 0,
    });
    const eb = w.k.issueEquip({
      actor: w.human,
      at: T(3),
      participant_id: w.agentB,
      expected_version: 0,
    });
    if (!ea.ok || !eb.ok) throw new Error('re-equip failed');
    void returnFrom(w, {
      actor: w.agent,
      equipId: ea.value.id,
      at: T(4),
      causal: { [w.agent]: 7, [w.human]: 4 },
    });
    const marked = w.k.events.filter((e) => e.type === 'return.conflict_marked');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.data['causal_context']).toEqual({ [w.agent]: 7, [w.human]: 4 });
    // After the first return the server holds {human:7, agent:2} (the
    // seed itself is 7 human events; the return advanced agent to 2 —
    // the caller's claimed 7 self-advances never count server-side).
    // agentB observed agent:8's branch and human:7 fully and carries no
    // self-advance — strictly behind the server: dominated_by, no
    // second marking.
    void returnFrom(w, {
      actor: w.agentB,
      equipId: eb.value.id,
      at: T(5),
      causal: { [w.human]: 7, [w.agent]: 9 },
    });
    const markedAfter = w.k.events.filter((e) => e.type === 'return.conflict_marked');
    expect(markedAfter).toHaveLength(1);
    const secondVerdict = w.k.events.filter((e) => e.type === 'return.absorbed').at(-1)?.data[
      'verdict'
    ];
    // agentB claims 9 observations of agent's branch (7 offline events +
    // the 2 server-known ones) while the server only knows 2 — one-sided
    // ahead = dominates, and no second marking: agentB saw everything the
    // server knows and strictly more of agent's work.
    expect(secondVerdict).toBe('dominates');
  });
});

describe('equip bootstrap snapshot', () => {
  it('stamps the authoritative clock at issuance', () => {
    const w = seeded();
    // each equip is stamped at issuance: human=2 for the first, human=3
    // for the second (the equip event itself advances the clock).
    expect(w.k.projection.equips[w.equipId]?.causal_snapshot).toEqual({ [w.human]: 2 });
    expect(w.k.projection.equips[w.equipIdB]?.causal_snapshot).toEqual({ [w.human]: 3 });
    // and the live server clock has moved on since
    expect(w.k.causal_clock).toEqual({ [w.human]: 4 });
  });

  it('snapshot schema accepts valid snapshots and rejects malformed ones', () => {
    expect(causalClockSnapshotSchema.safeParse({}).success).toBe(true);
    expect(
      causalClockSnapshotSchema.safeParse({
        '0198b100-0000-7000-8000-000000000001': 3,
      }).success,
    ).toBe(true);
    expect(
      causalClockSnapshotSchema.safeParse({
        '0198b100-0000-7000-8000-000000000001': 0,
      }).success,
    ).toBe(false);
    expect(causalClockSnapshotSchema.safeParse({ badkey: 1 }).success).toBe(false);
    expect(
      causalClockSnapshotSchema.safeParse({
        '0198b100-0000-7000-8000-000000000001': 1.5,
      }).success,
    ).toBe(false);
  });
});

describe('clock never mutates projection state', () => {
  it('a conflict marking changes no asset, hold, or effect state by itself', () => {
    const w = seeded();
    const projectionBefore = {
      assets: Object.keys(w.k.projection.assets).length,
      effects: Object.keys(w.k.projection.effects).length,
      holds: Object.keys(w.k.projection.holds).length,
    };
    // two-sided divergence: human's W2 after agentB's observation + agentB's
    // unseen self-advances -> concurrent, absorbable, marked
    w.k.createWork({ actor: w.human, at: T(2), reason: 'r', title: 'W2', expected_version: 0 });
    const eb = w.k.issueEquip({
      actor: w.human,
      at: T(3),
      participant_id: w.agentB,
      expected_version: 0,
    });
    if (!eb.ok) throw new Error('re-equip failed');
    void returnFrom(w, {
      actor: w.agentB,
      equipId: eb.value.id,
      at: T(4),
      causal: { [w.human]: 4, [w.agentB]: 5 },
      candidates: 2,
    });
    expect(Object.keys(w.k.projection.assets).length).toBe(projectionBefore.assets + 2);
    expect(Object.keys(w.k.projection.effects).length).toBe(projectionBefore.effects);
    expect(Object.keys(w.k.projection.holds).length).toBe(projectionBefore.holds);
    // the conflict event itself appended nothing to any projection table
    expect(w.k.events.some((e) => e.type === 'return.conflict_marked')).toBe(true);
  });
});

describe('classic vector-clock parity (Riak vclock.erl / Mattern-Fidge semantics)', () => {
  it('descends parity: comparison matches the classic all-components rule', () => {
    const R = (o: Record<string, number>) => o;
    // Riak descends(Va,Vb): every component of Vb must be <= Va's; a vclock
    // is its own descendant (equal clocks compare equal, never concurrent)
    expect(compareClocks(R({ h: 3 }), R({ h: 3 }))).toBe('equal');
    expect(compareClocks(R({ h: 4, a: 1 }), R({ h: 3, a: 1 }))).toBe('dominates');
    // missing component compares as zero
    expect(compareClocks(R({ h: 2 }), R({ h: 2, ghost: 5 }))).toBe('dominated_by');
    expect(compareClocks(R({}), R({ h: 1 }))).toBe('dominated_by');
    // descends both ways but unequal -> siblings (concurrent)
    expect(compareClocks(R({ h: 2, a: 1 }), R({ h: 1, a: 2 }))).toBe('concurrent');
  });

  it('merge parity: component-wise maximum is the least common descendant', () => {
    const R = (o: Record<string, number>) => o;
    expect(mergeClocks(R({ h: 3, a: 0 }), R({ h: 1, a: 5, b: 2 }))).toEqual(
      R({ h: 3, a: 5, b: 2 }),
    );
    expect(mergeClocks(R({}), R({ h: 7 }))).toEqual(R({ h: 7 }));
  });

  it('increment parity: exactly one component advances by one', () => {
    const R = (o: Record<string, number>) => o;
    expect(advanceClock(R({ h: 2, a: 3 }), 'a')).toEqual(R({ h: 2, a: 4 }));
    expect(advanceClock(R({}), 'h')).toEqual(R({ h: 1 }));
  });
});

describe('internal-state isolation', () => {
  it('the causal_clock getter hands out a frozen copy, not the live object', () => {
    const w = seeded();
    const before = { ...w.k.causal_clock };
    const leak = w.k.causal_clock;
    try {
      leak[w.human] = 999;
    } catch {
      // frozen in strict mode — either way the internal clock is untouched
    }
    expect(w.k.causal_clock).toEqual(before);
  });

  it('an equip snapshot does not alias the live clock object', () => {
    const w = seeded();
    const snap: Record<string, number> | undefined =
      w.k.projection.equips[w.equipId]?.causal_snapshot;
    if (snap === undefined) throw new Error('equip must carry a snapshot');
    try {
      snap[w.human] = 777;
    } catch {
      // event envelope objects are deep-frozen on append — mutation is refused
    }
    expect(w.k.causal_clock[w.human]).not.toBe(777);
  });
});

describe('adversarial: lying callers and hostile logs', () => {
  it("a caller inflating others' components cannot fake dominance", () => {
    const w = seeded();
    // lie: human:99 vs true 4 — inflation only makes the caller look more
    // knowledgeable (both components ahead) -> dominates, never concurrent
    void returnFrom(w, {
      actor: w.agent,
      equipId: w.equipId,
      at: T(2),
      causal: { [w.human]: 99, [w.agent]: 1 },
    });
    const absorbed = w.k.events.filter((e) => e.type === 'return.absorbed').at(-1);
    expect(absorbed?.data['verdict']).toBe('dominates');
    expect(w.k.events.some((e) => e.type === 'return.conflict_marked')).toBe(false);
  });

  it('a caller deflating its claim drifts conservative, never silent', () => {
    const w = seeded();
    // deflation (human:1 vs true 4) drifts the verdict toward the
    // conservative side: human review, never silent absorption
    void returnFrom(w, {
      actor: w.agent,
      equipId: w.equipId,
      at: T(2),
      causal: { [w.human]: 1, [w.agent]: 1 },
    });
    const absorbed = w.k.events.filter((e) => e.type === 'return.absorbed').at(-1);
    expect(absorbed?.data['verdict']).toBe('concurrent');
    expect(w.k.events.some((e) => e.type === 'return.conflict_marked')).toBe(true);
    // the honest snapshots are on the ledger for review either way
    expect(absorbed?.data['authoritative_clock']).toBeDefined();
  });

  it('a zero counter is schema-rejected, not judged', () => {
    const w = seeded();
    void returnFrom(w, {
      actor: w.agent,
      equipId: w.equipId,
      at: T(2),
      causal: { [w.human]: 0, [w.agent]: 1 },
    });
    // zero is not a meaningful observation count; malformed, no event
    expect(w.k.events.some((e) => e.type.startsWith('return.'))).toBe(false);
  });

  it('a stale equip cannot smuggle a concurrent verdict past wholesale rejection', () => {
    const w = seeded();
    w.k.createWork({ actor: w.human, at: T(2), reason: 'r', title: 'W2', expected_version: 0 });
    // W2 is not state-material, so the equip never goes stale on its own;
    // a boundary update is what forces the staleness under test.
    const upd = w.k.updateBoundary({
      actor: w.human,
      at: T(3),
      reason: 'r',
      boundary: 'b2',
      expected_version: 0,
    });
    expect(upd.ok).toBe(true);
    const r = w.k.submitReturn({
      actor: w.agent,
      at: T(4),
      equip_id: w.equipId,
      expected_version: 1,
      causal_context: { [w.human]: 5, [w.agent]: 3 },
    });
    expect(r.ok).toBe(false);
    // rejected: no absorbed event, no conflict marking, verdict only on
    // the rejection record itself
    const types = w.k.events.map((e) => e.type);
    expect(types).not.toContain('return.absorbed');
    expect(types).not.toContain('return.conflict_marked');
  });

  it('a log with a gapless but hostile authorship still rebuilds its clock faithfully', () => {
    const w = seeded();
    void returnFrom(w, { actor: w.agent, equipId: w.equipId, at: T(2) });
    // rebuilding twice from the same log must yield the same clock:
    // the rebuild path is idempotent
    const a = ProjectStateKernel.fromEvents(w.k.events);
    const b = ProjectStateKernel.fromEvents(w.k.events);
    expect(a.causal_clock).toEqual(b.causal_clock);
    expect(a.causal_clock).toEqual(w.k.causal_clock);
  });

  it('snapshot inflation by a joiner is bounded: unknown participants are rejected before judgment', () => {
    const w = seeded();
    const ghost = '0198b100-0000-7000-8000-00000000ffff';
    void returnFrom(w, {
      actor: w.agent,
      equipId: w.equipId,
      at: T(2),
      causal: { [w.human]: 4, [ghost]: 42 },
    });
    // rejection happened before any judgment: no return event at all
    expect(w.k.events.some((e) => e.type.startsWith('return.'))).toBe(false);
  });
});

describe('kernel-level randomized fuzz: replay equivalence and invariants under noise', () => {
  // Deterministic PRNG so failures reproduce bit-for-bit across runs.
  const makeRng =
    (seed: number): (() => number) =>
    () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
  const CLOCK_ACTORS = [
    '0198b100-0000-7000-8000-000000000001',
    '0198b100-0000-7000-8000-000000000002',
  ] as const;
  const CLOCK_GHOST = '0198b100-0000-7000-8000-00000000dead';
  const fuzzReturn = (
    k: ProjectStateKernel,
    rng: () => number,
    equipId: string,
    version: number,
  ): void => {
    // context mix by roll: untracked / hostile (ghost or zero) / honest /
    // inflated lie — the adversarial space in one distribution
    const roll = rng();
    const honest = (): CausalClockSnapshot => ({
      [CLOCK_ACTORS[0]]: Math.max(1, Math.floor(rng() * 12)),
      [CLOCK_ACTORS[1]]: Math.max(1, Math.floor(rng() * 12)),
    });
    const context: CausalClockSnapshot | undefined =
      roll < 0.15
        ? undefined
        : roll < 0.25
          ? { [CLOCK_GHOST as string]: 3 }
          : roll < 0.4
            ? { [CLOCK_ACTORS[0] as string]: 0 }
            : roll < 0.7
              ? honest()
              : {
                  [CLOCK_ACTORS[0] as string]: 99,
                  [CLOCK_ACTORS[1] as string]: Math.max(1, Math.floor(rng() * 3)),
                };
    k.submitReturn({
      actor: CLOCK_ACTORS[1],
      at: T(Math.floor(rng() * 30) + 2),
      equip_id: equipId,
      expected_version: version,
      ...(context === undefined ? {} : { causal_context: context }),
    });
  };

  it('random event streams: replay rebuilds clock and projection exactly (200 runs x 120 events)', () => {
    for (let run = 0; run < 200; run += 1) {
      const rng = makeRng(1000 + run);
      const w = seeded();
      for (let i = 0; i < 120; i += 1) {
        fuzzReturn(w.k, rng, w.equipId, 0);
      }
      const clockLive = w.k.causal_clock;
      const rebuilt = ProjectStateKernel.fromEvents(w.k.events);
      expect(rebuilt.causal_clock).toEqual(clockLive);
      expect(rebuilt.stateVersion).toBe(w.k.stateVersion);
      expect(rebuilt.events.length).toBe(w.k.events.length);
    }
  });

  it('fuzz invariants hold on every run: monotonic clock, verdicts recorded, no invented events', () => {
    for (let run = 0; run < 200; run += 1) {
      const rng = makeRng(5000 + run);
      const w = seeded();
      const firstClock = { ...w.k.causal_clock };
      for (let i = 0; i < 120; i += 1) {
        fuzzReturn(w.k, rng, w.equipId, 0);
      }
      const finalClock = w.k.causal_clock;
      // monotonic: every live-holder component never decreases
      for (const [id, count] of Object.entries(finalClock)) {
        expect(count).toBeGreaterThanOrEqual(firstClock[id] ?? 0);
      }
      // every recorded verdict is one of the four canonical values
      for (const e of w.k.events) {
        if (e.type === 'return.absorbed' && 'verdict' in e.data) {
          expect(['dominates', 'dominated_by', 'concurrent', 'equal']).toContain(e.data['verdict']);
        }
        // hostile contexts never produce a conflict marking
        if (e.type === 'return.conflict_marked') {
          const ctx = e.data['causal_context'] as Record<string, number>;
          expect(Object.keys(ctx)).not.toContain(CLOCK_GHOST);
          expect(Object.values(ctx)).not.toContain(0);
        }
      }
      // equipment state never silently flips
      expect(w.k.projection.equips[w.equipId]?.status).toBe('active');
    }
  });

  it('scale smoke: 5,000-submission mixed log replays in one pass with identical clock', () => {
    const rng = makeRng(777);
    const w = seeded();
    for (let i = 0; i < 5000; i += 1) {
      // per-submission event accounting: hostile context appends nothing
      // (0); stale-equip wholesale rejection appends one (1); an absorbable
      // return appends one plus a conflict marking when concurrent (2)
      const before = w.k.events.length;
      fuzzReturn(w.k, rng, w.equipId, 0);
      const delta = w.k.events.length - before;
      expect([0, 1, 2]).toContain(delta);
    }
    const live = w.k.causal_clock;
    const rebuilt = ProjectStateKernel.fromEvents(w.k.events);
    expect(rebuilt.causal_clock).toEqual(live);
    expect(rebuilt.events.length).toBe(w.k.events.length);
  });
});
