/** Snapshots are replay caches; neither policy evaluation nor restoration reads a wall clock. */
import { z } from 'zod';
import { projectionSnapshotSchema, type ProjectionSnapshot } from '../ports/event-store.js';
import type { StateEvent } from './events.js';
import { projectionSchema, capturePolicySchema, type KernelProjection } from './projection.js';
import { instantSchema, MILLISECONDS_PER_DAY } from '../schema/time.js';

const PROJECTION_STATE_KEYS = Object.freeze(Object.keys(projectionSchema.shape));

/** Capture-anchor state: the sequence and logical time of the last capture. */
const captureAnchorSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  at: instantSchema,
});
export type CaptureAnchor = Readonly<z.infer<typeof captureAnchorSchema>>;

/** Capture-window policy (the projection's policy row, structurally). */
export type CapturePolicy = Readonly<z.infer<typeof capturePolicySchema>>;

export interface CaptureDueInput {
  /** The log to evaluate over (seq-ordered). */
  readonly events: readonly { readonly seq: number; readonly at: string }[];
  /** The capture windows in force at evaluation time. */
  readonly policy: CapturePolicy;
  /** The last capture's anchor; null before the first capture ever. */
  readonly anchor: CaptureAnchor | null;
}

/** The capture window that made an evaluation due. */
export type CaptureTrigger = 'event-count' | 'time-window';

export interface CaptureDueEvaluation {
  readonly due: boolean;
  /** Which window fired; null when not due. */
  readonly trigger: CaptureTrigger | null;
  readonly events_since_anchor: number;
  readonly logical_days_since_anchor: number;
}

/**
 * Evaluates a contiguous, ordered log using its own timestamps. Before
 * the first capture, elapsed time starts at the first event; an empty
 * log is never due. Invalid windows or logical timestamps throw.
 */
export function evaluateCaptureDue(input: CaptureDueInput): CaptureDueEvaluation {
  const head = input.events[input.events.length - 1];
  const first = input.events[0];
  if (head === undefined || first === undefined) {
    return { due: false, trigger: null, events_since_anchor: 0, logical_days_since_anchor: 0 };
  }
  const policy = capturePolicySchema.parse({
    event_count_window: input.policy.event_count_window,
    time_window_days: input.policy.time_window_days,
  });
  const anchorSeq = input.anchor?.seq ?? 0;
  const anchorAt = input.anchor?.at ?? first.at;
  const anchorMs = Date.parse(anchorAt);
  const headMs = Date.parse(head.at);
  if (!Number.isFinite(anchorMs) || !Number.isFinite(headMs)) {
    throw new Error('capture due-ness: invalid logical timestamp in the log or anchor');
  }
  if (input.anchor !== null) captureAnchorSchema.parse(input.anchor);
  const eventsSince = head.seq - anchorSeq;
  const elapsedDays = (headMs - anchorMs) / MILLISECONDS_PER_DAY;
  if (eventsSince >= policy.event_count_window) {
    return {
      due: true,
      trigger: 'event-count',
      events_since_anchor: eventsSince,
      logical_days_since_anchor: elapsedDays,
    };
  }
  if (elapsedDays >= policy.time_window_days) {
    return {
      due: true,
      trigger: 'time-window',
      events_since_anchor: eventsSince,
      logical_days_since_anchor: elapsedDays,
    };
  }
  return {
    due: false,
    trigger: null,
    events_since_anchor: eventsSince,
    logical_days_since_anchor: elapsedDays,
  };
}

export type SnapshotUsabilityResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Validates the stored shape and its ledger anchors; full replay audits semantic equality. */
export function validateSnapshotUsability(
  snapshot: Pick<ProjectionSnapshot, 'state_version' | 'seq' | 'schema_version' | 'state'>,
  events: readonly StateEvent[],
  expectedSchemaVersion: number,
): SnapshotUsabilityResult {
  if (snapshot.schema_version !== expectedSchemaVersion) {
    return {
      ok: false,
      reason: `envelope schema version mismatch: snapshot ${String(snapshot.schema_version)} != current ${String(expectedSchemaVersion)}`,
    };
  }
  const stateSeq = snapshot.state['seq'];
  if (typeof stateSeq !== 'number' || !Number.isFinite(stateSeq) || stateSeq !== snapshot.seq) {
    return {
      ok: false,
      reason: `state seq cursor disagrees with the envelope seq (envelope ${String(snapshot.seq)})`,
    };
  }
  const cursorEvent = events.find((e) => e.seq === snapshot.seq);
  if (cursorEvent === undefined) {
    return {
      ok: false,
      reason: `sequence cursor ${String(snapshot.seq)} is not present in the log`,
    };
  }
  if (cursorEvent.state_version !== snapshot.state_version) {
    return {
      ok: false,
      reason: `state-version cursor ${String(snapshot.state_version)} disagrees with the log event's recorded version ${String(cursorEvent.state_version)}`,
    };
  }
  let state: KernelProjection;
  try {
    state = extractProjectionState(snapshot.state);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'invalid projection state',
    };
  }
  const creation = events.find(
    (event) => event.seq <= snapshot.seq && event.type === 'project.created',
  );
  if (state.project === null) {
    const businessRows = Object.entries(state).filter(
      ([key]) => key !== 'seq' && key !== 'project' && key !== 'policy' && key !== 'participants',
    );
    if (businessRows.some(([, value]) => Object.keys(value as object).length !== 0)) {
      return { ok: false, reason: 'snapshot contains business rows before project creation' };
    }
  }
  for (const asset of Object.values(state.assets)) {
    if (
      asset.lifecycle !== 'candidate' &&
      asset.lifecycle !== 'rejected' &&
      !Object.values(state.acceptances).some(
        (record) => record.asset_id === asset.id && record.result === 'accepted',
      )
    ) {
      return { ok: false, reason: 'snapshot contains a promoted asset without acceptance' };
    }
  }
  if (
    (creation === undefined && state.project !== null) ||
    (creation !== undefined &&
      (state.project === null ||
        state.project.id !== creation.data['project_id'] ||
        state.project.current_state_version !== snapshot.state_version)) ||
    (state.project === null) !== (state.policy === null)
  ) {
    return {
      ok: false,
      reason: 'snapshot project or state version disagrees with its event cursor',
    };
  }
  const anchor = extractCaptureAnchor(snapshot.state);
  if (anchor !== null && (anchor.seq !== snapshot.seq || anchor.at !== cursorEvent.at)) {
    return { ok: false, reason: 'capture anchor disagrees with the covered event' };
  }
  return { ok: true };
}

/**
 * Returns a validated snapshot payload. Capture metadata stays outside
 * the projection because replay must derive every projection field.
 * The result keeps the typed projection shape; the envelope parse at
 * persistence time is what re-validates it against the JSON wire record.
 */
export function serializeProjectionState(projection: KernelProjection): KernelProjection {
  return structuredClone(projectionSchema.parse(projection));
}

/**
 * Returns the same validation as the JSON wire record the snapshot
 * envelope persists — for fixtures that must build or mutate the stored
 * shape itself.
 */
export function serializeProjectionStateRecord(
  projection: KernelProjection,
): ProjectionSnapshot['state'] {
  return projectionSnapshotSchema.shape.state.parse(projectionSchema.parse(projection));
}

/**
 * Returns validated, owned projection rows. Missing or malformed fields
 * throw; a null project and policy are valid before project creation.
 */
export function extractProjectionState(state: Record<string, unknown>): KernelProjection {
  const out: Record<string, unknown> = {};
  for (const key of PROJECTION_STATE_KEYS) {
    if (!Object.hasOwn(state, key)) {
      throw new Error(`snapshot state is missing the '${key}' projection field`);
    }
    out[key] = state[key];
  }
  const parsed = projectionSchema.safeParse(out);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `invalid snapshot projection at ${issue?.path.join('.') ?? 'state'}: ${issue?.message ?? 'invalid shape'}`,
    );
  }
  return structuredClone(parsed.data);
}

/**
 * Returns null for an absent capture anchor and rejects a malformed one.
 */
export function extractCaptureAnchor(state: Record<string, unknown>): CaptureAnchor | null {
  const raw = state['capture_anchor'];
  if (raw === undefined || raw === null) return null;
  const parsed = captureAnchorSchema.safeParse(raw);
  if (!parsed.success) throw new Error('snapshot state carries a malformed capture anchor');
  return parsed.data;
}
