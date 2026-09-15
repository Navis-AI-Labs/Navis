/** Retention advice is separate from acceptance-time quality and cannot change authority. */
import { assertTransition } from '../schema/asset.js';
import type { AssetLifecycle } from '../schema/asset.js';
import { MILLISECONDS_PER_DAY } from '../schema/time.js';
import type { AssetRow, AcceptanceRow, DeliveryRow, HoldRow, WorkRow } from './projection.js';

/** Closed score range. */
export const STRENGTH_SCORE_MIN = 0;
export const STRENGTH_SCORE_MAX = 1;

/** Evidence floor and suggestion thresholds of the current evaluation contract. */
export const OBSERVATION_FLOOR_WORKS = 3;
export const SUGGESTION_THRESHOLD = 0.2;
export const NEUTRAL_BASELINE = 0.5;

/** Uncalibrated baseline parameters; deterministic tests do not establish business accuracy. */
export const EDGE_HALF_LIFE_DAYS = 14;
export const STALE_HORIZON_DAYS = 28;
export const STALE_DECAY_DAYS = 14;
export const UPSIDE_GAIN = 0.4;
export const REFERENCE_SATURATION = 2;
export const MAX_STALENESS_PENALTY = 0.45;

export type StrengthAssetRow = Pick<AssetRow, 'id' | 'lifecycle' | 'created_at'>;
export type StrengthAcceptanceRow = Pick<
  AcceptanceRow,
  'asset_id' | 'result' | 'created_at' | 'deleted_at'
>;
export type StrengthDeliveryRow = Pick<DeliveryRow, 'asset_id' | 'created_at' | 'deleted_at'>;
export type StrengthHoldRow = Pick<HoldRow, 'asset_refs' | 'created_at' | 'deleted_at'>;
export type StrengthWorkRow = Pick<WorkRow, 'created_at' | 'deleted_at'>;

export interface StrengthInput {
  readonly asset: StrengthAssetRow;
  readonly acceptances: Readonly<Record<string, StrengthAcceptanceRow>>;
  readonly deliveries: Readonly<Record<string, StrengthDeliveryRow>>;
  readonly holds: Readonly<Record<string, StrengthHoldRow>>;
  readonly works: Readonly<Record<string, StrengthWorkRow>>;
  /** The evaluation point on the projection's own logical timeline (the latest folded event's time). */
  readonly evaluationAt: string;
}

/** The named signals behind a score — carried into suggestions as data. */
export interface StrengthSignals {
  readonly acceptance_anchor: string;
  readonly observed_works: number;
  readonly edge_count: number;
  readonly weighted_signal: number;
  readonly last_edge_age_days: number | null;
}

export interface StrengthResult {
  readonly asset_id: string;
  readonly score: number;
  readonly signals: StrengthSignals;
}

export interface RetirementSuggestion {
  readonly asset_id: string;
  readonly score: number;
  readonly signals: StrengthSignals;
  readonly recommended_state: 'deprecated' | 'archived';
  readonly requires_confirmation: true;
}

function parseLogicalTime(value: string, what: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`strength evaluation: invalid logical timestamp for ${what}: ${value}`);
  }
  return ms;
}

function alive(row: Pick<AssetRow, 'deleted_at'>): boolean {
  return row.deleted_at === undefined;
}

/** Logical age in days between two timestamps on the projection's own timeline. */
function logicalAgeDays(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / MILLISECONDS_PER_DAY);
}

/**
 * The acceptance anchor: created-at of the asset's latest `accepted`
 * acceptance row, falling back to asset creation so candidate-stage assets
 * evaluate without inventing an anchor.
 */
export function acceptanceAnchor(
  asset: StrengthAssetRow,
  acceptances: Readonly<Record<string, StrengthAcceptanceRow>>,
): string {
  let latest: string | null = null;
  for (const row of Object.values(acceptances)) {
    if (row.asset_id !== asset.id || row.result !== 'accepted' || !alive(row)) continue;
    if (latest === null || row.created_at > latest) latest = row.created_at;
  }
  return latest ?? asset.created_at;
}

/**
 * Pure, deterministic strength evaluation: the same input always produces
 * the same score in `[0.0, 1.0]`. Below the observation floor the score is
 * the neutral baseline regardless of reference count — absence of evidence
 * is not evidence of uselessness.
 */
export function computeStrength(input: StrengthInput): StrengthResult {
  const anchor = acceptanceAnchor(input.asset, input.acceptances);
  const anchorMs = parseLogicalTime(anchor, 'acceptance anchor');
  const evaluationMs = parseLogicalTime(input.evaluationAt, 'evaluation point');
  if (evaluationMs < anchorMs) {
    throw new Error('strength evaluation: evaluation point precedes the acceptance anchor');
  }

  const observedWorks = Object.values(input.works).filter(
    (w) => alive(w) && parseLogicalTime(w.created_at, 'work created_at') > anchorMs,
  ).length;

  const edges: number[] = []; // each entry: age of one post-anchor reference edge, in logical days
  for (const d of Object.values(input.deliveries)) {
    if (!alive(d) || d.asset_id !== input.asset.id) continue;
    const created = parseLogicalTime(d.created_at, 'delivery created_at');
    if (created > anchorMs) edges.push(logicalAgeDays(created, evaluationMs));
  }
  for (const h of Object.values(input.holds)) {
    if (!alive(h) || !h.asset_refs?.includes(input.asset.id)) continue;
    const created = parseLogicalTime(h.created_at, 'hold created_at');
    if (created > anchorMs) edges.push(logicalAgeDays(created, evaluationMs));
  }
  edges.sort((a, b) => a - b); // stable, deterministic aggregation order

  const weightedSignal = edges.reduce((sum, age) => sum + 2 ** (-age / EDGE_HALF_LIFE_DAYS), 0);
  const lastEdgeAgeDays = edges[0] ?? null;

  let score: number;
  if (observedWorks < OBSERVATION_FLOOR_WORKS || lastEdgeAgeDays === null) {
    score = NEUTRAL_BASELINE;
  } else {
    const upside = (UPSIDE_GAIN * weightedSignal) / (weightedSignal + REFERENCE_SATURATION);
    const staleDays = Math.max(0, lastEdgeAgeDays - STALE_HORIZON_DAYS);
    const penalty = MAX_STALENESS_PENALTY * (staleDays / (staleDays + STALE_DECAY_DAYS));
    score = NEUTRAL_BASELINE + upside - penalty;
  }
  score = Math.min(STRENGTH_SCORE_MAX, Math.max(STRENGTH_SCORE_MIN, score));

  return {
    asset_id: input.asset.id,
    score,
    signals: {
      acceptance_anchor: anchor,
      observed_works: observedWorks,
      edge_count: edges.length,
      weighted_signal: weightedSignal,
      last_edge_age_days: lastEdgeAgeDays,
    },
  };
}

/**
 * Shapes a retirement suggestion as a pure data payload — never persisted,
 * never appended, never executed. Shaped only when the score crosses the
 * suggestion threshold AND the asset's lifecycle makes the recommended
 * transition legal through the schema's own transition table.
 */
export function shapeSuggestion(
  result: StrengthResult,
  lifecycle: AssetLifecycle,
): RetirementSuggestion | null {
  if (result.score >= SUGGESTION_THRESHOLD) return null;
  for (const target of ['deprecated', 'archived'] as const) {
    if (assertTransition(lifecycle, target).ok) {
      return {
        asset_id: result.asset_id,
        score: result.score,
        signals: result.signals,
        recommended_state: target,
        requires_confirmation: true,
      };
    }
  }
  return null;
}
