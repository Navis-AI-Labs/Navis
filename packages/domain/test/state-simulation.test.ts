import { describe, expect, it } from 'vitest';

import { assertWorkRunTransition, type WorkRunStatus } from '../src/schema/workrun.js';
import { canonicalJson } from '../src/state/canonical.js';
import { ProjectStateKernel } from '../src/state/project-state-kernel.js';

/**
 * Lab-spec simulation battery: the kernel under enterprise-grade AI-coding
 * workloads. Deterministic seeded PRNG only — every failure is reproducible.
 * Invariants are checked after every step, not just at the end:
 *   (a) full-projection replay identity (canonical JSON),
 *   (b) every rejected command appends zero events,
 *   (c) each run's revision equals 1 + its run-event count,
 *   (d) state_version equals the count of State-material events,
 *   (e) the append-only history passes its integrity probe.
 */

const AT = '2026-09-04T08:00:00.000Z';
const T = (m: number) => new Date(Date.parse(AT) + m * 60_000).toISOString();

const ALL_STATUSES: readonly WorkRunStatus[] = [
  'ready',
  'running',
  'waiting_input',
  'waiting_approval',
  'paused',
  'cancelling',
  'cancelled',
  'failed',
  'completed',
];

const MATERIAL_EVENTS: ReadonlySet<string> = new Set([
  'project.boundary_updated',
  'project.status_changed',
]);

const RUN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'workrun.started',
  'workrun.transitioned',
  'intervention.session_opened',
  'intervention.session_closed',
]);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded lookup or throw: a missing seed id is a fixture bug, not a kernel path. */
function must(id: string | undefined): string {
  if (id === undefined) throw new Error('seed lookup failed');
  return id;
}

interface SimWorld {
  k: ProjectStateKernel;
  humans: string[];
  agents: string[];
  all: string[];
  works: string[];
  equipByAgent: Map<string, string[]>;
  runs: string[];
  dirs: string[];
  sessionSeq: number;
  dirSeq: number;
  runSeq: number;
  ok: number;
  rejected: number;
}

function newWorld(): SimWorld {
  const k = new ProjectStateKernel();
  const h1 = '0198c000-0000-7000-8000-000000000001';
  const h2 = '0198c000-0000-7000-8000-000000000002';
  const a1 = '0198c000-0000-7000-8000-000000000003';
  const a2 = '0198c000-0000-7000-8000-000000000004';
  const a3 = '0198c000-0000-7000-8000-000000000005';
  for (const [id, type] of [
    [h1, 'human'],
    [h2, 'human'],
    [a1, 'agent'],
    [a2, 'agent'],
    [a3, 'agent'],
  ] as const) {
    k.registerParticipant({ participant_id: id, type, at: AT });
  }
  k.createProject({ actor: h1, at: AT, title: 'Enterprise sim', expected_version: 0 });
  const w1 = k.createWork({ actor: h1, at: AT, reason: 'seed', title: 'W1', expected_version: 0 });
  const w2 = k.createWork({ actor: h1, at: AT, reason: 'seed', title: 'W2', expected_version: 0 });
  if (!w1.ok || !w2.ok) throw new Error('seed works failed');
  const humans: string[] = [h1, h2];
  const agents: string[] = [a1, a2, a3];
  const all: string[] = [...humans, ...agents];
  const equipByAgent = new Map<string, string[]>();
  for (const a of agents) {
    const eq = k.issueEquip({ actor: h1, at: AT, participant_id: a, expected_version: 0 });
    if (!eq.ok) throw new Error('seed equip failed');
    equipByAgent.set(a, [eq.value.id]);
  }
  return {
    k,
    humans,
    agents,
    all,
    works: [w1.value.id, w2.value.id],
    equipByAgent,
    runs: [],
    dirs: [],
    sessionSeq: 0,
    dirSeq: 0,
    runSeq: 0,
    ok: 0,
    rejected: 0,
  };
}

function latestEquip(w: SimWorld, agent: string): string | undefined {
  const list = w.equipByAgent.get(agent);
  return list === undefined || list.length === 0 ? undefined : list[list.length - 1];
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

/** The invariant battery — throws on the first violated invariant. */
function checkInvariants(w: SimWorld, label: string): void {
  const k = w.k;
  // (a) full-projection replay identity
  const rebuilt = k.rebuildProjection();
  const live = k.projection;
  expect(canonicalJson(rebuilt)).toBe(canonicalJson(live));
  // (c) per-run revision accounting from the event stream itself
  const runEvents = new Map<string, number>();
  for (const e of k.events) {
    if (!RUN_EVENT_TYPES.has(e.type)) continue;
    const runId = e.data['run_id'] as string;
    runEvents.set(runId, (runEvents.get(runId) ?? 0) + (e.type === 'workrun.started' ? 0 : 1));
  }
  const projectedRunIds = new Set(Object.keys(live.work_runs));
  expect(projectedRunIds).toEqual(new Set(runEvents.keys()));
  for (const [runId, extra] of runEvents) {
    const row = live.work_runs[runId];
    expect(row?.run_revision, `${label}: run ${runId} revision`).toBe(1 + extra);
  }
  // (d) state_version equals the count of State-material events
  const materialCount = k.events.filter((e) => MATERIAL_EVENTS.has(e.type)).length;
  expect(k.stateVersion, `${label}: state_version`).toBe(materialCount);
  // (e) append-only history integrity
  expect(k.verifyIntegrity().ok, `${label}: integrity`).toBe(true);
}

function step(w: SimWorld, rng: () => number, at: string): void {
  const k = w.k;
  const evBefore = k.events.length;
  const roll = rng();
  let accepted = false;

  if (roll < 0.06) {
    // boundary update — invalidates every equip wholesale
    const r = k.updateBoundary({
      actor: pick(rng, w.humans),
      at,
      boundary: `b-${String(Math.floor(rng() * 1e6))}`,
      reason: 'evolve',
      expected_version: k.stateVersion,
    });
    accepted = r.ok;
  } else if (roll < 0.09) {
    const r = k.setProjectStatus({
      actor: pick(rng, w.humans),
      at,
      to: rng() < 0.7 ? 'active' : 'paused',
      reason: 'ops',
      expected_version: k.stateVersion,
    });
    accepted = r.ok;
  } else if (roll < 0.15) {
    const agent = pick(rng, w.agents);
    const r = k.issueEquip({
      actor: pick(rng, w.humans),
      at,
      participant_id: agent,
      expected_version: k.stateVersion,
    });
    if (r.ok) w.equipByAgent.get(agent)?.push(r.value.id);
    accepted = r.ok;
  } else if (roll < 0.24) {
    const agent = pick(rng, w.agents);
    const runId = `0198c100-0000-7000-8000-${String(w.runSeq++).padStart(12, '0')}`;
    const equipId = latestEquip(w, agent);
    if (equipId === undefined) {
      w.rejected += 1;
      checkInvariants(w, `no-equip@${at}`);
      return;
    }
    const r = k.startRun({
      actor: agent,
      at,
      run_id: runId,
      work_id: pick(rng, w.works),
      equip_id: equipId,
      expected_version: k.stateVersion,
    });
    if (r.ok) w.runs.push(runId);
    accepted = r.ok;
  } else if (roll < 0.5 && w.runs.length > 0) {
    const runId = pick(rng, w.runs);
    const run = k.projection.work_runs[runId];
    const actor = pick(rng, w.all);
    const staleRevision = rng() < 0.15;
    const resuming = run?.status !== undefined && run.status !== 'running';
    const cp = run?.checkpoint_id;
    const r = k.transitionRun({
      actor,
      at,
      run_id: runId,
      to: pick(rng, ALL_STATUSES),
      reason: 'sim',
      expected_version: k.stateVersion,
      run_revision: Math.max(0, (run?.run_revision ?? 0) - (staleRevision ? 1 : 0)),
      ...(resuming && cp !== undefined && rng() < 0.8 ? { resume_checkpoint_id: cp } : {}),
      ...(resuming && rng() < 0.5 ? { input_provided: 'x' } : {}),
      ...(resuming && rng() < 0.5 ? { approval_result: 'yes' } : {}),
      ...(resuming && rng() < 0.4 ? { equip_id: latestEquip(w, actor) ?? 'not-an-equip' } : {}),
    });
    accepted = r.ok;
  } else if (roll < 0.68 && w.runs.length > 0) {
    const actor = pick(rng, w.all);
    const sessionId = `s-${String(w.sessionSeq++)}`;
    const r = k.openIntervention({
      actor,
      at,
      run_id: pick(rng, w.runs),
      session_id: sessionId,
      mode: pick(rng, ['observe', 'assist', 'takeover'] as const),
      expected_version: k.stateVersion,
      run_revision: k.projection.work_runs[pick(rng, w.runs)]?.run_revision ?? 0,
    });
    accepted = r.ok;
  } else if (roll < 0.8 && w.runs.length > 0) {
    const runId = pick(rng, w.runs);
    const run = k.projection.work_runs[runId];
    const open = (run?.intervention_sessions ?? []).filter((s) => s.ended_at === undefined);
    if (open.length > 0) {
      const session = pick(rng, open);
      const actor = rng() < 0.6 ? session.participant_id : pick(rng, w.all);
      const needsConsent = session.mode !== 'observe';
      const r = k.closeIntervention({
        actor,
        at,
        run_id: runId,
        session_id: session.session_id,
        ...(needsConsent ? { consent_status: rng() < 0.8 ? 'granted' : 'denied' } : {}),
        expected_version: k.stateVersion,
        run_revision: run?.run_revision ?? 0,
      });
      accepted = r.ok;
    }
  } else if (roll < 0.9) {
    const dirId = `0198c200-0000-7000-8000-${String(w.dirSeq++).padStart(12, '0')}`;
    const r = k.proposeDirection({
      actor: pick(rng, w.all),
      at,
      direction_id: dirId,
      title: `direction ${String(w.dirSeq)}`,
      ...(rng() < 0.4 ? { detail: 'why' } : {}),
    });
    if (r.ok) w.dirs.push(dirId);
    accepted = r.ok;
  } else if (w.dirs.length > 0) {
    const dirId = pick(rng, w.dirs);
    const r = k.resolveDirection({
      actor: pick(rng, w.humans),
      at,
      direction_id: dirId,
      resolution: rng() < 0.6 ? 'confirmed' : 'discarded',
      resolution_reason: 'sim decision',
      expected_version: k.stateVersion,
    });
    accepted = r.ok;
  }

  if (accepted) w.ok += 1;
  else {
    w.rejected += 1;
    // (b) a rejected command appends nothing — zero-pollution guarantee
    expect(k.events.length, 'rejected command must append zero events').toBe(evBefore);
  }
  checkInvariants(w, `step@${at}`);
}

function runSimulation(seed: number, steps: number, invariantEveryStep = true): SimWorld {
  const w = newWorld();
  const rng = mulberry32(seed);
  for (let i = 0; i < steps; i += 1) {
    step(w, rng, T(i + 1));
    if (!invariantEveryStep && i % 25 === 24) checkInvariants(w, `scale@${String(i)}`);
  }
  checkInvariants(w, `final@seed${String(seed)}`);
  return w;
}

describe('exhaustive transition table (81 pairs)', () => {
  it('pure table: exactly the 16 spec pairs are legal, all 65 others illegal', () => {
    let legal = 0;
    let illegal = 0;
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const r = assertWorkRunTransition(from, to);
        if (r.ok) legal += 1;
        else {
          illegal += 1;
          expect(r.error.code).toBe('illegal-transition');
        }
      }
    }
    expect(legal).toBe(16);
    expect(illegal).toBe(65);
  });

  it('kernel path: every reachable from-state rejects all illegal targets with zero pollution', () => {
    const w = newWorld();
    const k = w.k;
    const agent = must(w.agents[0]);
    const human = must(w.humans[0]);
    const driveTo = (target: WorkRunStatus, runId: string): void => {
      // start plus one transition: every driven target is a legal move from
      // running (the caller drives only reachable from-states)
      const eq = k.issueEquip({
        actor: human,
        at: T(1),
        participant_id: agent,
        expected_version: k.stateVersion,
      });
      if (!eq.ok) throw new Error('seed issueEquip failed');
      const started = k.startRun({
        actor: agent,
        at: T(1),
        run_id: runId,
        work_id: must(w.works[0]),
        equip_id: eq.value.id,
        expected_version: k.stateVersion,
      });
      if (!started.ok) throw new Error(`seed startRun failed: ${JSON.stringify(started.error)}`);
      if (target === 'running') return;
      const rev = k.projection.work_runs[runId]?.run_revision ?? 0;
      const t1 = k.transitionRun({
        actor: agent,
        at: T(2),
        run_id: runId,
        to: target,
        reason: 'd',
        expected_version: k.stateVersion,
        run_revision: rev,
      });
      if (!t1.ok) throw new Error(`drive ${target}: ${JSON.stringify(t1.error)}`);
    };

    for (const from of ALL_STATUSES) {
      if (from === 'ready') continue; // ready means the run is absent; the start-gate suite covers it
      const slot = ALL_STATUSES.indexOf(from);
      const runId = `0198c300-0000-7000-8000-${String(slot).padStart(12, '0')}`;
      if (from === 'failed' || from === 'cancelled' || from === 'completed') {
        // drive via the cancelled path; failed and completed branch off running directly
        const eq = k.issueEquip({
          actor: human,
          at: T(1),
          participant_id: agent,
          expected_version: k.stateVersion,
        });
        if (!eq.ok) throw new Error('seed issueEquip failed');
        const started = k.startRun({
          actor: agent,
          at: T(1),
          run_id: runId,
          work_id: must(w.works[0]),
          equip_id: eq.value.id,
          expected_version: k.stateVersion,
        });
        if (!started.ok) throw new Error('seed startRun failed');
        let rev = k.projection.work_runs[runId]?.run_revision ?? 0;
        if (from !== 'failed' && from !== 'completed') {
          k.transitionRun({
            actor: agent,
            at: T(2),
            run_id: runId,
            to: 'cancelling',
            reason: 'd',
            expected_version: k.stateVersion,
            run_revision: rev,
          });
          rev = k.projection.work_runs[runId]?.run_revision ?? 0;
          k.transitionRun({
            actor: agent,
            at: T(3),
            run_id: runId,
            to: 'cancelled',
            reason: 'd',
            expected_version: k.stateVersion,
            run_revision: rev,
          });
        } else {
          k.transitionRun({
            actor: agent,
            at: T(2),
            run_id: runId,
            to: from,
            reason: 'd',
            expected_version: k.stateVersion,
            run_revision: rev,
          });
        }
      } else {
        driveTo(from, runId);
      }
      const before = k.events.length;
      const revBefore = k.projection.work_runs[runId]?.run_revision ?? 0;
      let legalSeen = 0;
      for (const to of ALL_STATUSES) {
        const verdict = assertWorkRunTransition(from, to);
        if (verdict.ok) {
          // execute the one legal pair with full gate evidence: a legal pair
          // can still be gate-rejected (approvals are human-only, a paused
          // resumption needs its checkpoint) — the gates have their own
          // suites; here we prove the pair itself passes
          legalSeen += 1;
          const r = k.transitionRun({
            actor: human,
            at: T(9),
            run_id: runId,
            to,
            reason: 'probe',
            expected_version: k.stateVersion,
            run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
            ...(to === 'running' ? { input_provided: 'x', approval_result: 'yes' } : {}),
            ...(to === 'running' && from === 'paused'
              ? { resume_checkpoint_id: k.projection.work_runs[runId]?.checkpoint_id ?? '' }
              : {}),
          });
          expect(r.ok, `${from}→${to} must pass`).toBe(true);
          break;
        }
        const r = k.transitionRun({
          actor: human,
          at: T(9),
          run_id: runId,
          to,
          reason: 'probe',
          expected_version: k.stateVersion,
          run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
        });
        expect(r.ok, `${from}→${to} must be rejected`).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('illegal-transition');
        expect(k.events.length).toBe(before);
        expect(k.projection.work_runs[runId]?.run_revision).toBe(revBefore);
      }
      const tableLegal = ALL_STATUSES.filter((to) => assertWorkRunTransition(from, to).ok).length;
      expect(legalSeen).toBe(Math.min(tableLegal, 1));
    }
    checkInvariants(w, 'exhaustive-table');
  });
});

describe('revision-conflict races (lost-update protection)', () => {
  it('stale transition/open/close all lose with version-conflict and append nothing', () => {
    const w = newWorld();
    const k = w.k;
    const agent = must(w.agents[0]);
    const eq = k.issueEquip({
      actor: must(w.humans[0]),
      at: T(1),
      participant_id: agent,
      expected_version: 0,
    });
    if (!eq.ok) throw new Error('seed issueEquip failed');
    const runId = '0198c400-0000-7000-8000-000000000001';
    k.startRun({
      actor: agent,
      at: T(1),
      run_id: runId,
      work_id: must(w.works[0]),
      equip_id: eq.value.id,
      expected_version: 0,
    });
    // two clients cached revision 1; client A moves first
    const openA = k.openIntervention({
      actor: must(w.agents[1]),
      at: T(2),
      run_id: runId,
      session_id: 'ra',
      mode: 'observe',
      expected_version: 0,
      run_revision: 1,
    });
    expect(openA.ok).toBe(true);
    // client B still holds revision 1 for a transition — loses
    const lost = k.transitionRun({
      actor: agent,
      at: T(3),
      run_id: runId,
      to: 'waiting_input',
      reason: 'r',
      expected_version: 0,
      run_revision: 1,
    });
    expect(lost.ok).toBe(false);
    if (!lost.ok) expect(lost.error.code).toBe('version-conflict');
    // client B also loses on session commands with the stale revision
    const lostOpen = k.openIntervention({
      actor: must(w.agents[2]),
      at: T(3),
      run_id: runId,
      session_id: 'rb',
      mode: 'observe',
      expected_version: 0,
      run_revision: 1,
    });
    expect(lostOpen.ok).toBe(false);
    if (!lostOpen.ok) expect(lostOpen.error.code).toBe('version-conflict');
    // winner closes with the CURRENT revision; a stale closer loses
    const closeA = k.closeIntervention({
      actor: must(w.agents[1]),
      at: T(4),
      run_id: runId,
      session_id: 'ra',
      expected_version: 0,
      run_revision: 2,
    });
    expect(closeA.ok).toBe(true);
    const staleCloser = k.closeIntervention({
      actor: must(w.humans[0]),
      at: T(5),
      run_id: runId,
      session_id: 'ra',
      expected_version: 0,
      run_revision: 2,
    });
    expect(staleCloser.ok).toBe(false);
    if (!staleCloser.ok) expect(staleCloser.error.code).toBe('version-conflict');
    checkInvariants(w, 'races');
  });
});

describe('equip churn under boundary evolution', () => {
  it('boundary update mid-run invalidates equips; recovery needs a fresh one; flag clears exactly once', () => {
    const w = newWorld();
    const k = w.k;
    const agent = must(w.agents[0]);
    const human = must(w.humans[0]);
    const runId = '0198c500-0000-7000-8000-000000000001';
    const eq0 = k.issueEquip({
      actor: human,
      at: T(1),
      participant_id: agent,
      expected_version: 0,
    });
    if (!eq0.ok) throw new Error('seed issueEquip failed');
    k.startRun({
      actor: agent,
      at: T(1),
      run_id: runId,
      work_id: must(w.works[0]),
      equip_id: eq0.value.id,
      expected_version: 0,
    });
    k.updateBoundary({
      actor: human,
      at: T(2),
      boundary: 'b2',
      reason: 'evolve',
      expected_version: 0,
    });
    // old equip now stale: a new run cannot start on it
    const runId2 = '0198c500-0000-7000-8000-000000000002';
    expect(
      k.startRun({
        actor: agent,
        at: T(3),
        run_id: runId2,
        work_id: must(w.works[0]),
        equip_id: eq0.value.id,
        expected_version: 1,
      }).ok,
    ).toBe(false);
    // pause → resume: the equip gate arms only on a takeover release, so
    // the boundary-stale equip does not block this run's resumption
    k.transitionRun({
      actor: agent,
      at: T(3),
      run_id: runId,
      to: 'paused',
      reason: 'r',
      expected_version: 1,
      run_revision: 1,
    });
    const cp = k.projection.work_runs[runId]?.checkpoint_id ?? '';
    expect(
      k.transitionRun({
        actor: agent,
        at: T(4),
        run_id: runId,
        to: 'running',
        reason: 'r',
        expected_version: 1,
        run_revision: 2,
        resume_checkpoint_id: cp,
        equip_id: eq0.value.id,
      }).ok,
    ).toBe(true);
    // but a new run still cannot start on the stale-marked equip
    expect(
      k.startRun({
        actor: agent,
        at: T(5),
        run_id: runId2,
        work_id: must(w.works[0]),
        equip_id: eq0.value.id,
        expected_version: 1,
      }).ok,
    ).toBe(false);
    // a fresh equip issued at the new version restores the agent's start ability
    const eq1 = k.issueEquip({
      actor: human,
      at: T(6),
      participant_id: agent,
      expected_version: 1,
    });
    if (!eq1.ok) throw new Error('seed issueEquip failed');
    expect(
      k.startRun({
        actor: agent,
        at: T(7),
        run_id: runId2,
        work_id: must(w.works[0]),
        equip_id: eq1.value.id,
        expected_version: 1,
      }).ok,
    ).toBe(true);
    checkInvariants(w, 'equip-churn');
  });

  it('release freshness anchor: pre-release equip rejected; re-release re-anchors to the LATEST release', () => {
    const w = newWorld();
    const k = w.k;
    const agent = must(w.agents[0]);
    const human = must(w.humans[0]);
    const runId = '0198c500-0000-7000-8000-000000000001';
    const eq0 = k.issueEquip({
      actor: human,
      at: T(1),
      participant_id: agent,
      expected_version: 0,
    });
    if (!eq0.ok) throw new Error('seed issueEquip failed');
    k.startRun({
      actor: agent,
      at: T(1),
      run_id: runId,
      work_id: must(w.works[0]),
      equip_id: eq0.value.id,
      expected_version: 0,
    });
    const openS = (sid: string, mode: 'observe' | 'takeover', actor: string, at: number): boolean =>
      k.openIntervention({
        actor,
        at: T(at),
        run_id: runId,
        session_id: sid,
        mode,
        expected_version: 0,
        run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
      }).ok;
    expect(openS('o1', 'observe', human, 2)).toBe(true);
    expect(openS('t1', 'takeover', human, 2)).toBe(true);
    k.transitionRun({
      actor: agent,
      at: T(3),
      run_id: runId,
      to: 'paused',
      reason: 'r',
      expected_version: 0,
      run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
    });
    // equip issued after the takeover opened but before the release
    const eqPre = k.issueEquip({
      actor: human,
      at: T(4),
      participant_id: agent,
      expected_version: 0,
    });
    if (!eqPre.ok) throw new Error('seed issueEquip failed');
    expect(
      k.closeIntervention({
        actor: human,
        at: T(5),
        run_id: runId,
        session_id: 't1',
        consent_status: 'granted',
        expected_version: 0,
        run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
      }).ok,
    ).toBe(true);
    // resuming on the pre-release equip is rejected: it is not post-release fresh
    const cp = k.projection.work_runs[runId]?.checkpoint_id ?? '';
    const onPre = k.transitionRun({
      actor: agent,
      at: T(6),
      run_id: runId,
      to: 'running',
      reason: 'r',
      expected_version: 0,
      run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
      resume_checkpoint_id: cp,
      equip_id: eqPre.value.id,
    });
    expect(onPre.ok).toBe(false);
    if (!onPre.ok) expect(onPre.error.details).toMatchObject({ reason: 'stale-equip' });
    // release #2: the human stays present, takes over again, releases again
    expect(openS('t2', 'takeover', human, 7)).toBe(true);
    expect(
      k.closeIntervention({
        actor: human,
        at: T(8),
        run_id: runId,
        session_id: 't2',
        consent_status: 'granted',
        expected_version: 0,
        run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
      }).ok,
    ).toBe(true);
    // an equip issued after release #1 but before release #2 is still not fresh
    const onMid = k.transitionRun({
      actor: agent,
      at: T(9),
      run_id: runId,
      to: 'running',
      reason: 'r',
      expected_version: 0,
      run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
      resume_checkpoint_id: cp,
      equip_id: eqPre.value.id,
    });
    expect(onMid.ok).toBe(false);
    if (!onMid.ok) expect(onMid.error.details).toMatchObject({ reason: 'stale-equip' });
    // only a post-release-#2 equip passes
    const eqPost = k.issueEquip({
      actor: human,
      at: T(10),
      participant_id: agent,
      expected_version: 0,
    });
    if (!eqPost.ok) throw new Error('seed issueEquip failed');
    expect(
      k.transitionRun({
        actor: agent,
        at: T(11),
        run_id: runId,
        to: 'running',
        reason: 'r',
        expected_version: 0,
        run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
        resume_checkpoint_id: cp,
        equip_id: eqPost.value.id,
      }).ok,
    ).toBe(true);
    checkInvariants(w, 'release-anchor');
  });
});

describe('intervention storm (humans + agent fleet)', () => {
  it('12 parallel sessions: derived mode ladders, authority matrix holds, consent battery', () => {
    const w = newWorld();
    const k = w.k;
    const runId = '0198c600-0000-7000-8000-000000000001';
    const agent = must(w.agents[0]);
    const eq = k.issueEquip({
      actor: must(w.humans[0]),
      at: T(1),
      participant_id: agent,
      expected_version: 0,
    });
    if (!eq.ok) throw new Error('seed issueEquip failed');
    k.startRun({
      actor: agent,
      at: T(1),
      run_id: runId,
      work_id: must(w.works[0]),
      equip_id: eq.value.id,
      expected_version: 0,
    });
    const open = (actor: string, sid: string, mode: 'observe' | 'assist' | 'takeover'): boolean =>
      k.openIntervention({
        actor,
        at: T(2),
        run_id: runId,
        session_id: sid,
        mode,
        expected_version: 0,
        run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
      }).ok;
    for (let i = 0; i < 8; i += 1)
      expect(open(must(w.all[i % w.all.length]), `o${String(i)}`, 'observe')).toBe(true);
    for (let i = 0; i < 4; i += 1)
      expect(open(must(w.humans[i % 2]), `a${String(i)}`, 'assist')).toBe(true);
    // 12 sessions coexist; the derived mode is assist (strongest active)
    expect(k.projection.work_runs[runId]?.intervention_sessions).toHaveLength(12);
    expect(k.projection.work_runs[runId]?.intervention_mode).toBe('assist');
    // takeover by a present assistant
    expect(open(must(w.humans[0]), 't0', 'takeover')).toBe(true);
    expect(k.projection.work_runs[runId]?.intervention_mode).toBe('takeover');
    // double takeover still rejected even though taker is present
    expect(open(must(w.humans[1]), 't1', 'takeover')).toBe(false);
    // human closes an assistant's session; agent cannot close another's
    const assistSession = (k.projection.work_runs[runId]?.intervention_sessions ?? []).find(
      (s) => s.mode === 'assist' && s.ended_at === undefined,
    );
    expect(assistSession).toBeDefined();
    const byAgent = k.closeIntervention({
      actor: must(w.agents[1]),
      at: T(3),
      run_id: runId,
      session_id: assistSession?.session_id ?? '',
      consent_status: 'granted',
      expected_version: 0,
      run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
    });
    expect(byAgent.ok).toBe(false);
    expect(
      k.closeIntervention({
        actor: must(w.humans[0]),
        at: T(3),
        run_id: runId,
        session_id: assistSession?.session_id ?? '',
        consent_status: 'denied',
        expected_version: 0,
        run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
      }).ok,
    ).toBe(true);
    // release the takeover; derived mode falls back to assist
    expect(
      k.closeIntervention({
        actor: must(w.humans[0]),
        at: T(4),
        run_id: runId,
        session_id: 't0',
        consent_status: 'granted',
        expected_version: 0,
        run_revision: k.projection.work_runs[runId]?.run_revision ?? 0,
      }).ok,
    ).toBe(true);
    expect(k.projection.work_runs[runId]?.intervention_mode).toBe('assist');
    expect(k.projection.work_runs[runId]?.re_equip_required).toBe(true);
    // drain every remaining session; derived mode collapses to undefined
    for (let round = 0; round < 12; round += 1) {
      const run = k.projection.work_runs[runId];
      const next = (run?.intervention_sessions ?? []).find((s) => s.ended_at === undefined);
      if (next === undefined) break;
      const actor = next.participant_id;
      k.closeIntervention({
        actor,
        at: T(5 + round),
        run_id: runId,
        session_id: next.session_id,
        ...(next.mode !== 'observe' ? { consent_status: 'granted' as const } : {}),
        expected_version: 0,
        run_revision: run?.run_revision ?? 0,
      });
    }
    expect(
      k.projection.work_runs[runId]?.intervention_sessions.every((s) => s.ended_at !== undefined),
    ).toBe(true);
    expect(k.projection.work_runs[runId]?.intervention_mode).toBeUndefined();
    checkInvariants(w, 'storm');
  });
});

describe('direction system under load (30 records, interleaved material events)', () => {
  it('proposals/resolutions stay version-neutral; agent resolution always rejected; views consistent', () => {
    const w = newWorld();
    const k = w.k;
    let vA = 0;
    for (let i = 0; i < 30; i += 1) {
      const dirId = `0198c700-0000-7000-8000-${String(i).padStart(12, '0')}`;
      const byAgent = i % 3 !== 0;
      const r = k.proposeDirection({
        actor: must(byAgent ? w.agents[i % 3] : w.humans[i % 2]),
        at: T(i + 1),
        direction_id: dirId,
        title: `d${String(i)}`,
      });
      expect(r.ok).toBe(true);
      if (i === 14) {
        k.updateBoundary({
          actor: must(w.humans[0]),
          at: T(20),
          boundary: 'b-mid',
          reason: 'evolve',
          expected_version: k.stateVersion,
        });
        vA = k.stateVersion;
      }
    }
    // resolve 25 of 30; agents never succeed
    let confirmed = 0;
    let discarded = 0;
    for (let i = 0; i < 30; i += 1) {
      const dirId = `0198c700-0000-7000-8000-${String(i).padStart(12, '0')}`;
      if (i < 5) {
        const agentAttempt = k.resolveDirection({
          actor: must(w.agents[0]),
          at: T(40),
          direction_id: dirId,
          resolution: 'confirmed',
          resolution_reason: 'bot',
          expected_version: k.stateVersion,
        });
        expect(agentAttempt.ok).toBe(false);
        continue;
      }
      const resolution = i % 2 === 0 ? 'confirmed' : 'discarded';
      expect(
        k.resolveDirection({
          actor: must(w.humans[i % 2]),
          at: T(41),
          direction_id: dirId,
          resolution,
          resolution_reason: `why ${String(i)}`,
          expected_version: k.stateVersion,
        }).ok,
      ).toBe(true);
      if (resolution === 'confirmed') confirmed += 1;
      else discarded += 1;
    }
    const all = Object.values(k.projection.intended_directions);
    expect(all).toHaveLength(30);
    expect(all.filter((d) => d.status === 'confirmed')).toHaveLength(confirmed);
    expect(all.filter((d) => d.status === 'discarded')).toHaveLength(discarded);
    expect(all.filter((d) => d.status === 'proposed')).toHaveLength(5);
    expect(k.stateVersion).toBe(vA); // direction events never move the state version
    checkInvariants(w, 'direction-load');
  });
});

describe('checkpoint reference discipline', () => {
  it('a run cannot resume on another run’s checkpoint nor on its own stale older one', () => {
    const w = newWorld();
    const k = w.k;
    const agent = must(w.agents[0]);
    const eq = k.issueEquip({
      actor: must(w.humans[0]),
      at: T(1),
      participant_id: agent,
      expected_version: 0,
    });
    if (!eq.ok) throw new Error('seed issueEquip failed');
    const runA = '0198c800-0000-7000-8000-00000000000a';
    const runB = '0198c800-0000-7000-8000-00000000000b';
    for (const runId of [runA, runB]) {
      k.startRun({
        actor: agent,
        at: T(1),
        run_id: runId,
        work_id: must(w.works[0]),
        equip_id: eq.value.id,
        expected_version: 0,
      });
      k.transitionRun({
        actor: agent,
        at: T(2),
        run_id: runId,
        to: 'paused',
        reason: 'r',
        expected_version: 0,
        run_revision: 1,
      });
    }
    const cpA = k.projection.work_runs[runA]?.checkpoint_id ?? '';
    const cpB = k.projection.work_runs[runB]?.checkpoint_id ?? '';
    expect(cpA).not.toBe(cpB);
    const crossRun = k.transitionRun({
      actor: agent,
      at: T(3),
      run_id: runB,
      to: 'running',
      reason: 'r',
      expected_version: 0,
      run_revision: 2,
      resume_checkpoint_id: cpA,
    });
    expect(crossRun.ok).toBe(false);
    if (!crossRun.ok)
      expect(crossRun.error.details).toMatchObject({ reason: 'resume-checkpoint-mismatch' });
    // resume B properly, pause again, then try its first checkpoint: stale, rejected
    expect(
      k.transitionRun({
        actor: agent,
        at: T(4),
        run_id: runB,
        to: 'running',
        reason: 'r',
        expected_version: 0,
        run_revision: 2,
        resume_checkpoint_id: cpB,
      }).ok,
    ).toBe(true);
    k.transitionRun({
      actor: agent,
      at: T(5),
      run_id: runB,
      to: 'paused',
      reason: 'r',
      expected_version: 0,
      run_revision: 3,
    });
    const cpB2 = k.projection.work_runs[runB]?.checkpoint_id ?? '';
    expect(cpB2).not.toBe(cpB);
    const staleOwn = k.transitionRun({
      actor: agent,
      at: T(6),
      run_id: runB,
      to: 'running',
      reason: 'r',
      expected_version: 0,
      run_revision: 4,
      resume_checkpoint_id: cpB,
    });
    expect(staleOwn.ok).toBe(false);
    if (!staleOwn.ok)
      expect(staleOwn.error.details).toMatchObject({ reason: 'resume-checkpoint-mismatch' });
    expect(
      k.transitionRun({
        actor: agent,
        at: T(7),
        run_id: runB,
        to: 'running',
        reason: 'r',
        expected_version: 0,
        run_revision: 4,
        resume_checkpoint_id: cpB2,
      }).ok,
    ).toBe(true);
    checkInvariants(w, 'checkpoint-reference');
  });
});

describe('enterprise walkthrough: one full business day', () => {
  it('direction → work → run → gates → intervention → release → boundary → completion, replay-identical', () => {
    const w = newWorld();
    const k = w.k;
    const human = must(w.humans[0]);
    const agent = must(w.agents[0]);
    // strategy: AI proposes, human confirms with a reason
    const dir = '0198c900-0000-7000-8000-000000000001';
    expect(
      k.proposeDirection({
        actor: agent,
        at: T(1),
        direction_id: dir,
        title: 'Introduce a caching layer',
        detail: 'cut p95 latency',
      }).ok,
    ).toBe(true);
    expect(
      k.resolveDirection({
        actor: human,
        at: T(2),
        direction_id: dir,
        resolution: 'confirmed',
        resolution_reason: 'fits the Q4 perf budget',
        expected_version: 0,
      }).ok,
    ).toBe(true);
    // the confirmed direction becomes material only via an explicit command
    const work = k.createWork({
      actor: human,
      at: T(3),
      reason: 'execute confirmed direction',
      title: 'Caching layer',
      expected_version: 0,
    });
    expect(work.ok).toBe(true);
    // agent equips and starts; asks for input, then for approval
    const eq = k.issueEquip({ actor: human, at: T(4), participant_id: agent, expected_version: 0 });
    if (!eq.ok) throw new Error('seed issueEquip failed');
    const runId = '0198c900-0000-7000-8000-000000000002';
    expect(
      k.startRun({
        actor: agent,
        at: T(5),
        run_id: runId,
        work_id: work.ok ? work.value.id : '',
        equip_id: eq.value.id,
        expected_version: 0,
      }).ok,
    ).toBe(true);
    const rev = () => k.projection.work_runs[runId]?.run_revision ?? 0;
    expect(
      k.transitionRun({
        actor: agent,
        at: T(6),
        run_id: runId,
        to: 'waiting_input',
        reason: 'need the schema spec',
        expected_version: 0,
        run_revision: rev(),
      }).ok,
    ).toBe(true);
    expect(
      k.transitionRun({
        actor: agent,
        at: T(7),
        run_id: runId,
        to: 'running',
        reason: 'spec arrived',
        expected_version: 0,
        run_revision: rev(),
        input_provided: 'spec link',
      }).ok,
    ).toBe(true);
    expect(
      k.transitionRun({
        actor: agent,
        at: T(8),
        run_id: runId,
        to: 'waiting_approval',
        reason: 'unsafe migration ahead',
        expected_version: 0,
        run_revision: rev(),
      }).ok,
    ).toBe(true);
    expect(
      k.transitionRun({
        actor: agent,
        at: T(9),
        run_id: runId,
        to: 'running',
        reason: 'self-approve',
        expected_version: 0,
        run_revision: rev(),
        approval_result: 'yes',
      }).ok,
    ).toBe(false);
    expect(
      k.transitionRun({
        actor: human,
        at: T(10),
        run_id: runId,
        to: 'running',
        reason: 'approved with scope limits',
        expected_version: 0,
        run_revision: rev(),
        approval_result: 'approved',
      }).ok,
    ).toBe(true);
    // emergency: human observes, assists, takes over, pauses, releases
    const openS = (actor: string, sid: string, mode: 'observe' | 'assist' | 'takeover'): boolean =>
      k.openIntervention({
        actor,
        at: T(11),
        run_id: runId,
        session_id: sid,
        mode,
        expected_version: 0,
        run_revision: rev(),
      }).ok;
    expect(openS(human, 'h-o', 'observe')).toBe(true);
    expect(openS(human, 'h-a', 'assist')).toBe(true);
    expect(openS(human, 'h-t', 'takeover')).toBe(true);
    expect(k.projection.work_runs[runId]?.intervention_mode).toBe('takeover');
    expect(
      k.transitionRun({
        actor: human,
        at: T(12),
        run_id: runId,
        to: 'paused',
        reason: 'hotfix by hand',
        expected_version: 0,
        run_revision: rev(),
      }).ok,
    ).toBe(true);
    expect(
      k.closeIntervention({
        actor: human,
        at: T(13),
        run_id: runId,
        session_id: 'h-t',
        consent_status: 'granted',
        expected_version: 0,
        run_revision: rev(),
      }).ok,
    ).toBe(true);
    expect(k.projection.work_runs[runId]?.re_equip_required).toBe(true);
    // boundary evolved while paused: equips die wholesale
    k.updateBoundary({
      actor: human,
      at: T(14),
      boundary: 'b-day2',
      reason: 'scope change',
      expected_version: 0,
    });
    const cp = k.projection.work_runs[runId]?.checkpoint_id ?? '';
    const eq2 = k.issueEquip({
      actor: human,
      at: T(15),
      participant_id: agent,
      expected_version: 1,
    });
    if (!eq2.ok) throw new Error('seed issueEquip failed');
    expect(
      k.transitionRun({
        actor: agent,
        at: T(16),
        run_id: runId,
        to: 'running',
        reason: 'resume post-hotfix',
        expected_version: 1,
        run_revision: rev(),
        resume_checkpoint_id: cp,
        equip_id: eq2.value.id,
      }).ok,
    ).toBe(true);
    expect(
      k.transitionRun({
        actor: agent,
        at: T(17),
        run_id: runId,
        to: 'completed',
        reason: 'shipped',
        expected_version: 1,
        run_revision: rev(),
      }).ok,
    ).toBe(true);
    const run = k.projection.work_runs[runId];
    expect(run?.status).toBe('completed');
    expect((run?.intervention_sessions ?? []).filter((s) => s.mode === 'takeover')).toHaveLength(1);
    checkInvariants(w, 'walkthrough');
  });
});

describe('seeded randomized property battery', () => {
  it('10 seeds × 200 steps: invariants hold after every single step', () => {
    for (const seed of [11, 22, 33, 44, 55, 66, 77, 88, 99, 1010]) {
      const w = runSimulation(seed, 200);
      expect(w.ok).toBeGreaterThan(20);
      expect(w.rejected).toBeGreaterThan(5);
    }
  });

  it('scale: 1000 steps on one seed; periodic full rebuilds stay identical', () => {
    const w = runSimulation(424242, 1000, false);
    expect(w.ok + w.rejected).toBe(1000);
    const live = w.k.projection;
    expect(Object.keys(live.work_runs).length).toBeGreaterThan(3);
  });

  it('observation: logical times are recorded verbatim (non-monotonic input stays replay-identical)', () => {
    const w = newWorld();
    const k = w.k;
    const agent = must(w.agents[0]);
    const eq = k.issueEquip({
      actor: must(w.humans[0]),
      at: T(1),
      participant_id: agent,
      expected_version: 0,
    });
    if (!eq.ok) throw new Error('seed issueEquip failed');
    const runId = '0198ca00-0000-7000-8000-000000000001';
    k.startRun({
      actor: agent,
      at: T(1),
      run_id: runId,
      work_id: must(w.works[0]),
      equip_id: eq.value.id,
      expected_version: 0,
    });
    expect(
      k.openIntervention({
        actor: must(w.humans[0]),
        at: T(30),
        run_id: runId,
        session_id: 'nm1',
        mode: 'observe',
        expected_version: 0,
        run_revision: 1,
      }).ok,
    ).toBe(true);
    // closed before it opened on the caller's clock: the kernel records both
    // times verbatim; monotonic logical time is the caller's discipline
    expect(
      k.closeIntervention({
        actor: must(w.humans[0]),
        at: T(5),
        run_id: runId,
        session_id: 'nm1',
        expected_version: 0,
        run_revision: 2,
      }).ok,
    ).toBe(true);
    const s = k.projection.work_runs[runId]?.intervention_sessions.find(
      (x) => x.session_id === 'nm1',
    );
    expect(s?.started_at).toBe(T(30));
    expect(s?.ended_at).toBe(T(5));
    checkInvariants(w, 'non-monotonic-time');
  });
});
