import { z } from 'zod';
import type {
  ParticipantRow,
  ProjectRow,
  PolicyRow,
  WorkRow,
  AssetRow,
  HoldRow,
  AcceptanceRow,
  CheckpointRow,
  DeliveryRow,
  EffectRow,
  EquipRow,
  WorkRunRow,
  IntendedDirectionRow,
  KernelProjection,
  RunSessionRow,
} from './projection.js';
import { canonicalEquals, deepFreeze, immutableCopy } from './canonical.js';
import { EventHistory, verifyEventHistory } from './event-history.js';
import type { StateEvent } from './events.js';
import { parseEventData } from './event-data.js';
import { scopeVisibleForProject } from './scope-visibility.js';
import { extractProjectionState, validateSnapshotUsability } from './snapshot.js';
import type { ProjectionSnapshot } from '../ports/event-store.js';
import { kernelErrors, type KernelError } from '../errors/kernel.js';
import { assertTransition, assetSchema, type Asset } from '../schema/asset.js';
import { uuidv7, uuidv7Schema } from '../schema/ids.js';
import { MILLISECONDS_PER_DAY, instantSchema } from '../schema/time.js';
import { intendedDirectionSchema } from '../schema/intended-direction.js';
import { participantSchema, participantTypeSchema } from '../schema/participant.js';
import { projectSchema, projectStatusSchema, stateVersionSchema } from '../schema/project.js';
import { textSchema } from '../schema/text.js';
import { workSchema } from '../schema/work.js';
import { acceptanceResultSchema } from '../schema/acceptance.js';
import { deliveryTargetTypeSchema } from '../schema/delivery.js';
import { holdKindSchema, holdSeveritySchema, holdStatusSchema } from '../schema/hold.js';
import {
  executionRefsSchema,
  interventionModeSchema,
  workRunStatusSchema,
} from '../schema/workrun.js';
import { causalClockSnapshotSchema, type CausalClockSnapshot } from '../schema/causal-clock.js';
import { advanceClock, compareClocks } from './vector-clock.js';
import type { SchemaError } from '../errors/schema.js';
import type { AssetLifecycle } from '../schema/asset.js';
import type { HoldStatus } from '../schema/hold.js';
import type { WorkRunStatus } from '../schema/workrun.js';
import { assertWorkRunTransition } from '../schema/workrun.js';
import {
  checkCloseAuthority,
  checkTakeoverOpening,
  checkTerminalConsent,
  initialConsent,
  strongestActiveMode,
} from './intervention.js';

/**
 * Authority for one project: commands enforce policy and append facts;
 * replay alone updates the projection. Business denials return registry
 * errors, while invalid persisted data raises an integrity error.
 */
/** Serialized UTF-8 budget for an Equip's verified fact references. */
export const EQUIP_SIZE_BUDGET = 64 * 1024;
/** Retention window during which a competitive result may be reactivated. */
export const COMPETITIVE_GRACE_PERIOD_DAYS = 90;
/** Schema version of the kernel's event representation. */
export const STATE_EVENT_SCHEMA_VERSION = 1;
/**
 * Accepted capture-window defaults, seeded into the policy row at project
 * creation. Overridable per project via the human-gated
 * `updatePolicy` command; a policy update applies forward only.
 */
export const CAPTURE_EVENT_COUNT_WINDOW_DEFAULT = 500;
export const CAPTURE_TIME_WINDOW_DAYS_DEFAULT = 7;

/** The closed event vocabulary the kernel emits. */
export const KERNEL_EVENT_TYPES = [
  'participant.registered',
  'project.created',
  'project.boundary_updated',
  'project.policy_updated',
  'project.status_changed',
  'work.created',
  'work.redirected',
  'work.status_changed',
  'asset.created',
  'asset.lifecycle_changed',
  'asset.purged',
  'acceptance.recorded',
  'hold.registered',
  'hold.activated',
  'hold.resolved',
  'hold.accepted',
  'hold.dormanted',
  'hold.invalidated',
  'checkpoint.created',
  'equip.issued',
  'equip.budget_exceeded',
  'return.absorbed',
  'return.rejected',
  'return.conflict_marked',
  'effect.recorded',
  'effect.closed',
  'delivery.recorded',
  'delivery.confirmed',
  'direction.proposed',
  'direction.resolved',
  'workrun.started',
  'workrun.transitioned',
  'intervention.session_opened',
  'intervention.session_closed',
] as const;

export type KernelEventType = (typeof KERNEL_EVENT_TYPES)[number];

/** The hold-status-carrying subset of the kernel event vocabulary. */
type HoldEventType = Extract<KernelEventType, `hold.${string}`>;

/**
 * State-material events are the only events that advance
 * project_state_version: boundary updates (goal, acceptance criteria,
 * constraints — the Project's direction fields) and project status
 * changes. Acceptance-criteria structure changes ride the boundary event
 * (criteria are direction fields carried by it). Everything else advances
 * only the event seq and repeats the current version.
 */
const STATE_MATERIAL_EVENTS: ReadonlySet<string> = new Set([
  'project.boundary_updated',
  'project.status_changed',
]);

/** Hold event type keyed by target status: the emitted event is the transition. */
const HOLD_EVENT_TYPE: Readonly<Record<HoldStatus, KernelEventType>> = Object.freeze({
  registered: 'hold.registered',
  active: 'hold.activated',
  resolved: 'hold.resolved',
  accepted: 'hold.accepted',
  dormant: 'hold.dormanted',
  invalidated: 'hold.invalidated',
});

const HOLD_TARGET_STATUS: Readonly<Record<HoldEventType, HoldStatus>> = Object.freeze({
  // hold.registered creates the row (handled in its own case); listed for totality.
  'hold.registered': 'registered',
  'hold.activated': 'active',
  'hold.resolved': 'resolved',
  'hold.accepted': 'accepted',
  'hold.dormanted': 'dormant',
  'hold.invalidated': 'invalidated',
});

/**
 * Hold transition table per the accepted baseline: registered→active (the
 * human confirmation); active→resolved/accepted/dormant/invalidated;
 * dormant→invalidated; and reactivation (dormant/invalidated/accepted/
 * resolved→active), which is human-only with a required reason.
 */
const HOLD_TRANSITIONS: Readonly<
  Record<
    HoldStatus,
    readonly {
      readonly to: HoldStatus;
      readonly humanOnly: boolean;
      readonly reasonRequired: boolean;
    }[]
  >
> = {
  registered: [{ to: 'active', humanOnly: true, reasonRequired: false }],
  active: [
    { to: 'resolved', humanOnly: false, reasonRequired: false },
    { to: 'accepted', humanOnly: false, reasonRequired: false },
    { to: 'dormant', humanOnly: false, reasonRequired: false },
    { to: 'invalidated', humanOnly: false, reasonRequired: false },
  ],
  dormant: [
    { to: 'active', humanOnly: true, reasonRequired: true },
    { to: 'invalidated', humanOnly: false, reasonRequired: false },
  ],
  invalidated: [{ to: 'active', humanOnly: true, reasonRequired: true }],
  accepted: [{ to: 'active', humanOnly: true, reasonRequired: true }],
  resolved: [{ to: 'active', humanOnly: true, reasonRequired: true }],
};

/** The derived equip handed to the caller at issuance — never persisted as business data. */
export interface IssuedEquip {
  readonly id: string;
  readonly work_id?: string;
  readonly participant_id?: string;
  readonly state_version: number;
  readonly causal_snapshot: CausalClockSnapshot;
  readonly status: 'active';
  readonly issued_at: string;
  readonly verified_facts: readonly string[];
  readonly active_assets: readonly string[];
  readonly active_holds: readonly string[];
  readonly boundary?: string;
  readonly acceptance_criteria?: readonly string[];
  readonly allowed_actions?: readonly string[];
}

export type KernelResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KernelError | SchemaError };

function success<T>(value: T): KernelResult<T> {
  return { ok: true, value: immutableCopy(value) };
}

type FieldCheck = readonly [name: string, schema: z.ZodType, value: unknown];

/** Converts field-schema failures into the kernel's stable validation error shape. */
function invalidFields(action: string, checks: readonly FieldCheck[]): KernelError | undefined {
  const fields: string[] = [];
  for (const [name, schema, value] of checks) {
    const result = schema.safeParse(value);
    if (!result.success) fields.push(name);
  }
  return fields.length === 0
    ? undefined
    : kernelErrors.forbidden(action, { reason: 'invalid-fields', fields });
}

/**
 * Validates that textSchema fields are not whitespace-only.
 * Returns the field name if invalid, undefined if all valid.
 */
function whitespaceOnlyTextField(
  checks: readonly [name: string, value: string | readonly string[] | undefined][],
): string | undefined {
  for (const [name, value] of checks) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim().length === 0) return name;
      }
    } else {
      if (typeof value === 'string' && value.trim().length === 0) return name;
    }
  }
  return undefined;
}

const jsonRecordSchema = z.record(z.string(), z.json());
const uuidListSchema = z.array(uuidv7Schema).max(100);

// ---------------------------------------------------------------------------
// Mutable draft mirrors (applyEvent mutates these; the public projection is
// the readonly view).
// ---------------------------------------------------------------------------

type Draft<T> = { -readonly [K in keyof T]: T[K] };
interface MutableProjection {
  seq: number;
  project: Draft<ProjectRow> | null;
  policy: Draft<PolicyRow> | null;
  participants: Record<string, Draft<ParticipantRow>>;
  works: Record<string, Draft<WorkRow>>;
  assets: Record<string, Draft<AssetRow>>;
  holds: Record<string, Draft<HoldRow>>;
  acceptances: Record<string, Draft<AcceptanceRow>>;
  checkpoints: Record<string, Draft<CheckpointRow>>;
  deliveries: Record<string, Draft<DeliveryRow>>;
  effects: Record<string, Draft<EffectRow>>;
  equips: Record<string, Draft<EquipRow>>;
  work_runs: Record<string, Draft<WorkRunRow>>;
  intended_directions: Record<string, Draft<IntendedDirectionRow>>;
}

const emptyProjection = (): MutableProjection => ({
  seq: 0,
  project: null,
  policy: null,
  participants: {},
  works: {},
  assets: {},
  holds: {},
  acceptances: {},
  checkpoints: {},
  deliveries: {},
  effects: {},
  equips: {},
  work_runs: {},
  intended_directions: {},
});

/** Tombstone read-side: every lookup and gate evaluation excludes deleted rows. */
const alive = (row: Pick<AssetRow, 'deleted_at'>): boolean => row.deleted_at === undefined;

/**
 * Both restore entry points use the same applier. A snapshot is a cache;
 * full replay remains the audit for a structurally valid but incorrect cache.
 */
function restoreThenFold(
  events: readonly StateEvent[],
  snapshot: ProjectionSnapshot,
): KernelProjection {
  validateEventLog(events);
  const usability = validateSnapshotUsability(snapshot, events, STATE_EVENT_SCHEMA_VERSION);
  if (!usability.ok) {
    throw new Error(`unusable snapshot: ${usability.reason}`);
  }
  const d: MutableProjection = Object.assign(
    emptyProjection(),
    extractProjectionState(snapshot.state),
  );
  for (const e of events) {
    if (e.seq <= snapshot.seq) continue; // covered by the snapshot
    applyEvent(d, e);
  }
  return d;
}

/** Validates the complete ledger before any snapshot can seed a projection. */
function validateEventLog(events: readonly StateEvent[]): void {
  const integrity = verifyEventHistory(events);
  if (!integrity.ok) {
    throw new Error(`invalid event log at seq ${String(integrity.atSeq)}: ${integrity.reason}`);
  }
  const registered = new Set<string>();
  let stateVersion = 0;
  for (const event of events) {
    if (event.schema_version !== STATE_EVENT_SCHEMA_VERSION) {
      throw new Error(`invalid event log: unsupported schema version at seq ${String(event.seq)}`);
    }
    if (!KERNEL_EVENT_TYPES.includes(event.type as KernelEventType)) {
      throw new Error(`invalid event: unknown event type ${event.type}`);
    }
    try {
      parseEventData(event.type, event.data);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'schema violation';
      throw new Error(`invalid event data at seq ${String(event.seq)}: ${detail}`, {
        cause: error,
      });
    }
    if (STATE_MATERIAL_EVENTS.has(event.type)) stateVersion += 1;
    if (event.state_version !== stateVersion) {
      throw new Error(`invalid event log: state-version mismatch at seq ${String(event.seq)}`);
    }
    const actor = event.actor;
    if (actor !== null && actor !== undefined && !registered.has(actor)) {
      throw new Error(`invalid event log: actor not registered at seq ${String(event.seq)}`);
    }
    if (event.type === 'participant.registered') {
      const participantId = event.data['participant_id'];
      if (typeof participantId !== 'string' || registered.has(participantId)) {
        throw new Error(`invalid event log: duplicate participant at seq ${String(event.seq)}`);
      }
      registered.add(participantId);
    }
  }
}

/** Replay helper: a row a later event touches must exist — a missing row means a corrupt log. */
function must<O>(row: O | null | undefined, what: string): O {
  if (row === null || row === undefined)
    throw new Error(`invalid event: replay references missing ${what}`);
  return row;
}

/**
 * The single replay applier. Both the live append path and the full
 * rebuild fold events through THIS function — replay identity holds by
 * construction and is verified via canonical JSON equality.
 *
 * Project time (`updated_at`/`updated_by`) is written EXCLUSIVELY here,
 * from each event's at/actor — command paths never touch those fields
 * (guard-tested). The projection's current_state_version is likewise
 * synced here from the event envelope.
 */
function applyEvent(d: MutableProjection, e: StateEvent): void {
  const data = e.data;
  switch (e.type) {
    case 'participant.registered': {
      d.participants[data['participant_id'] as string] = {
        id: data['participant_id'] as string,
        ...(data['project_id'] === undefined ? {} : { project_id: data['project_id'] as string }),
        type: data['type'] as 'human' | 'agent',
        ...(data['display_name'] === undefined
          ? {}
          : { display_name: data['display_name'] as string }),
        ...(data['role'] === undefined ? {} : { role: data['role'] as string }),
        created_at: e.at,
      };
      break;
    }
    case 'project.created': {
      d.project = {
        id: data['project_id'] as string,
        title: data['title'] as string,
        ...(data['purpose'] === undefined ? {} : { purpose: data['purpose'] as string }),
        ...(data['boundary'] === undefined ? {} : { boundary: data['boundary'] as string }),
        ...(data['acceptance_criteria'] === undefined
          ? {}
          : { acceptance_criteria: data['acceptance_criteria'] as readonly string[] }),
        status: 'active',
        current_state_version: 0,
        created_at: e.at,
      };
      d.policy = {
        event_count_window: CAPTURE_EVENT_COUNT_WINDOW_DEFAULT,
        time_window_days: CAPTURE_TIME_WINDOW_DAYS_DEFAULT,
        updated_at: e.at,
        updated_by: e.actor ?? null,
      };
      break;
    }
    case 'project.policy_updated': {
      const policy = must(d.policy, 'policy row');
      if (data['event_count_window'] !== undefined) {
        policy.event_count_window = data['event_count_window'] as number;
      }
      if (data['time_window_days'] !== undefined) {
        policy.time_window_days = data['time_window_days'] as number;
      }
      policy.updated_at = e.at;
      policy.updated_by = e.actor ?? null;
      break;
    }
    case 'project.boundary_updated': {
      const p = must(d.project, 'project');
      if (data['boundary'] !== undefined) p.boundary = data['boundary'] as string;
      if (data['acceptance_criteria'] !== undefined) {
        p.acceptance_criteria = data['acceptance_criteria'] as readonly string[];
      }
      // Full-invalidation response: every equip bound to an older state
      // version is marked stale; in-flight returns against it are then
      // rejected wholesale by submit_return's version guard.
      for (const id of Object.keys(d.equips)) {
        const equip = d.equips[id];
        if (equip?.status === 'active' && equip.state_version < e.state_version) {
          equip.status = 'stale';
        }
      }
      break;
    }
    case 'project.status_changed': {
      must(d.project, 'project').status = data['to'] as ProjectRow['status'];
      break;
    }
    case 'work.created': {
      d.works[data['work_id'] as string] = {
        id: data['work_id'] as string,
        project_id: data['project_id'] as string,
        title: data['title'] as string,
        status: 'planned',
        ...(data['direction'] === undefined ? {} : { direction: data['direction'] as string }),
        ...(data['acceptance_criteria'] === undefined
          ? {}
          : { acceptance_criteria: data['acceptance_criteria'] as readonly string[] }),
        ...(data['depends_on'] === undefined
          ? {}
          : { depends_on: data['depends_on'] as readonly string[] }),
        aggregate_revision: 1,
        created_at: e.at,
      };
      break;
    }
    case 'work.redirected': {
      const w = must(d.works[data['work_id'] as string], 'work');
      w.direction = data['direction'] as string;
      w.aggregate_revision += 1;
      const cp = data['checkpoint'] as Record<string, unknown> | undefined;
      if (cp !== undefined) {
        d.checkpoints[cp['id'] as string] = {
          id: cp['id'] as string,
          work_id: data['work_id'] as string,
          reason: cp['reason'] as string,
          captured_at: e.at,
          state_version: e.state_version,
          position: cp['position'] as { readonly work_id: string; readonly redirected_to: string },
        };
      }
      break;
    }
    case 'work.status_changed': {
      const w = must(d.works[data['work_id'] as string], 'work');
      w.status = data['to'] as WorkRow['status'];
      w.aggregate_revision += 1;
      break;
    }
    case 'asset.created': {
      const seed = data['asset'] as Record<string, unknown>;
      d.assets[seed['id'] as string] = {
        id: seed['id'] as string,
        kind: seed['kind'] as AssetRow['kind'],
        scope: seed['scope'] as AssetRow['scope'],
        ...(seed['project_id'] === undefined ? {} : { project_id: seed['project_id'] as string }),
        lifecycle: 'candidate',
        ...(seed['provenance'] === undefined ? {} : { provenance: seed['provenance'] as string }),
        ...(seed['content'] === undefined
          ? {}
          : { content: seed['content'] as NonNullable<AssetRow['content']> }),
        ...(seed['valid_from'] === undefined ? {} : { valid_from: seed['valid_from'] as string }),
        ...(seed['valid_to'] === undefined ? {} : { valid_to: seed['valid_to'] as string }),
        created_at: e.at,
      };
      break;
    }
    case 'asset.lifecycle_changed': {
      const a = must(d.assets[data['asset_id'] as string], 'asset');
      if (a.lifecycle === 'candidate' && (data['to'] === 'active' || data['to'] === 'rejected')) {
        const verdict = data['to'] === 'active' ? 'accepted' : 'rejected';
        if (
          !Object.values(d.acceptances).some(
            (record) => record.asset_id === a.id && record.result === verdict,
          )
        ) {
          throw new Error('invalid event: candidate lifecycle decision has no acceptance record');
        }
      }
      a.lifecycle = data['to'] as AssetRow['lifecycle'];
      if (data['to'] === 'archived') a.archived_at = e.at;
      if (data['to'] === 'competitive_superseded') {
        a.competitive_superseded_at = e.at;
      } else {
        delete a.competitive_superseded_at;
      }
      break;
    }
    case 'asset.purged': {
      // Retirement tombstone: the row stays in replay history but every
      // read-side lookup and gate excludes it from here on.
      must(d.assets[data['asset_id'] as string], 'asset').deleted_at = e.at;
      break;
    }
    case 'acceptance.recorded': {
      d.acceptances[data['acceptance_id'] as string] = {
        id: data['acceptance_id'] as string,
        asset_id: data['asset_id'] as string,
        result: data['result'] as AcceptanceRow['result'],
        ...(data['rationale'] === undefined ? {} : { rationale: data['rationale'] as string }),
        criteria_snapshot: data['criteria_snapshot'] as Record<string, unknown>,
        ...(data['evidence_refs'] === undefined
          ? {}
          : { evidence_refs: data['evidence_refs'] as readonly string[] }),
        actor: data['actor'] as string,
        created_at: e.at,
      };
      break;
    }
    case 'hold.registered': {
      d.holds[data['hold_id'] as string] = {
        id: data['hold_id'] as string,
        project_id: data['project_id'] as string,
        kind: data['kind'] as HoldRow['kind'],
        severity: data['severity'] as HoldRow['severity'],
        status: data['initial_status'] as HoldStatus,
        blocks_delivery: data['blocks_delivery'] as boolean,
        statement: data['statement'] as string,
        ...(data['fowler_quadrant'] === undefined
          ? {}
          : { fowler_quadrant: data['fowler_quadrant'] as HoldRow['fowler_quadrant'] }),
        ...(data['source_event_ids'] === undefined
          ? {}
          : { source_event_ids: data['source_event_ids'] as readonly string[] }),
        ...(data['registered_during_work'] === undefined
          ? {}
          : { registered_during_work: data['registered_during_work'] as string }),
        ...(data['asset_refs'] === undefined
          ? {}
          : { asset_refs: data['asset_refs'] as readonly string[] }),
        registered_by: data['registered_by'] as string,
        ...(data['applicability'] === undefined
          ? {}
          : { applicability: data['applicability'] as string }),
        created_at: e.at,
      };
      break;
    }
    case 'hold.activated':
    case 'hold.resolved':
    case 'hold.accepted':
    case 'hold.dormanted':
    case 'hold.invalidated': {
      const h = must(d.holds[data['hold_id'] as string], 'hold');
      h.status = HOLD_TARGET_STATUS[e.type];
      break;
    }
    case 'checkpoint.created': {
      // Standalone checkpoints are not a command — the redirect
      // command creates them via work.redirected. Kept in the vocabulary
      // for replay symmetry with the storage layer's checkpoints table.
      break;
    }
    case 'equip.issued': {
      d.equips[data['equip_id'] as string] = {
        id: data['equip_id'] as string,
        ...(data['work_id'] === undefined ? {} : { work_id: data['work_id'] as string }),
        ...(data['participant_id'] === undefined
          ? {}
          : { participant_id: data['participant_id'] as string }),
        state_version: e.state_version,
        ...(data['causal_snapshot'] === undefined
          ? {}
          : { causal_snapshot: data['causal_snapshot'] as CausalClockSnapshot }),
        status: 'active',
        created_at: e.at,
      };
      break;
    }
    case 'equip.budget_exceeded':
    case 'return.rejected': {
      // Audit-only events: budget diagnostics and wholesale rejections
      // change no projection state (a rejected return's candidates and
      // effects must never enter the projection).
      break;
    }
    case 'return.conflict_marked': {
      // Audit-only: the conflict marking exists so human review can see the
      // parallel observation; the clock never mutates projection state.
      break;
    }
    case 'return.absorbed': {
      const candidates = data['candidates'] as readonly Record<string, unknown>[];
      for (const seed of candidates) {
        d.assets[seed['id'] as string] = {
          id: seed['id'] as string,
          kind: seed['kind'] as AssetRow['kind'],
          scope: 'project',
          project_id: must(d.project, 'project').id,
          lifecycle: 'candidate',
          ...(seed['provenance'] === undefined ? {} : { provenance: seed['provenance'] as string }),
          ...(seed['content'] === undefined
            ? {}
            : { content: seed['content'] as NonNullable<AssetRow['content']> }),
          created_at: e.at,
        };
      }
      const effects = data['effects'] as readonly Record<string, unknown>[];
      for (const seed of effects) {
        d.effects[seed['id'] as string] = {
          id: seed['id'] as string,
          ...(seed['asset_ref'] === undefined ? {} : { asset_ref: seed['asset_ref'] as string }),
          ...(seed['description'] === undefined
            ? {}
            : { description: seed['description'] as string }),
          status: 'unknown',
          created_at: e.at,
        };
      }
      break;
    }
    case 'effect.recorded': {
      d.effects[data['effect_id'] as string] = {
        id: data['effect_id'] as string,
        ...(data['asset_ref'] === undefined ? {} : { asset_ref: data['asset_ref'] as string }),
        ...(data['description'] === undefined
          ? {}
          : { description: data['description'] as string }),
        status: 'unknown',
        created_at: e.at,
      };
      break;
    }
    case 'effect.closed': {
      const ef = must(d.effects[data['effect_id'] as string], 'effect');
      ef.status = data['outcome'] as EffectRow['status'];
      ef.closed_at = e.at;
      break;
    }
    case 'delivery.recorded': {
      d.deliveries[data['delivery_id'] as string] = {
        id: data['delivery_id'] as string,
        asset_id: data['asset_id'] as string,
        target_ref: data['target_ref'] as string,
        target_type: data['target_type'] as DeliveryRow['target_type'],
        dispatched_at: e.at,
        version: data['version'] as string,
        attempt_no: data['attempt_no'] as number,
        delivered_by: data['delivered_by'] as string,
        confirmation_status: 'delivered',
        created_at: e.at,
      };
      break;
    }
    case 'delivery.confirmed': {
      const dl = must(d.deliveries[data['delivery_id'] as string], 'delivery');
      dl.confirmation_status = data['outcome'] as DeliveryRow['confirmation_status'];
      dl.confirmed_by = data['confirmed_by'] as string;
      dl.confirmed_at = e.at;
      if (data['feedback'] !== undefined) dl.feedback = data['feedback'] as string;
      break;
    }
    case 'direction.proposed': {
      d.intended_directions[data['direction_id'] as string] = {
        id: data['direction_id'] as string,
        project_id: must(d.project, 'project').id,
        title: data['title'] as string,
        ...(data['detail'] === undefined ? {} : { detail: data['detail'] as string }),
        status: 'proposed',
        proposed_by: e.actor ?? '',
        proposed_at: e.at,
        created_at: e.at,
      };
      break;
    }
    case 'direction.resolved': {
      const dir = must(d.intended_directions[data['direction_id'] as string], 'direction');
      dir.status = data['resolution'] as IntendedDirectionRow['status'];
      if (e.actor !== null && e.actor !== undefined) dir.resolved_by = e.actor;
      dir.resolved_at = e.at;
      dir.resolution_reason = data['resolution_reason'] as string;
      break;
    }
    case 'workrun.started': {
      d.work_runs[data['run_id'] as string] = {
        id: data['run_id'] as string,
        work_id: data['work_id'] as string,
        ...(data['parent_run_id'] === undefined
          ? {}
          : { parent_run_id: data['parent_run_id'] as string }),
        status: 'running',
        run_revision: 1,
        ...(data['attempt'] === undefined ? {} : { attempt: data['attempt'] as number }),
        ...(data['execution_refs'] === undefined
          ? {}
          : { execution_refs: data['execution_refs'] as Record<string, string> }),
        input_state_version: e.state_version,
        intervention_sessions: [],
        created_at: e.at,
      };
      break;
    }
    case 'workrun.transitioned': {
      const run = must(d.work_runs[data['run_id'] as string], 'work run');
      run.status = data['to'] as WorkRunRow['status'];
      run.run_revision = data['run_revision'] as number;
      const cp = data['checkpoint'] as Record<string, unknown> | undefined;
      if (cp !== undefined) {
        d.checkpoints[cp['id'] as string] = {
          id: cp['id'] as string,
          work_id: run.work_id,
          ...(cp['run_id'] === undefined ? {} : { run_id: cp['run_id'] as string }),
          ...(cp['reason'] === undefined ? {} : { reason: cp['reason'] as string }),
          captured_at: e.at,
          state_version: e.state_version,
          ...(cp['position'] === undefined
            ? {}
            : { position: cp['position'] as Record<string, unknown> }),
          ...(cp['resume_ref'] === undefined
            ? {}
            : { resume_ref: cp['resume_ref'] as Record<string, string> }),
        };
        run.checkpoint_id = cp['id'] as string;
      }
      const resume = data['resume_checkpoint_id'] as string | undefined;
      if (resume !== undefined) run.checkpoint_id = resume;
      // the first successful resuming transition clears the release flag
      if (run.re_equip_required === true && data['resume'] === true) {
        run.re_equip_required = false;
      }
      break;
    }
    case 'intervention.session_opened': {
      const run = must(d.work_runs[data['run_id'] as string], 'work run');
      const session: Draft<RunSessionRow> = {
        session_id: data['session_id'] as string,
        participant_id: e.actor ?? (data['participant_id'] as string),
        mode: data['mode'] as RunSessionRow['mode'],
        started_at: e.at,
        ...(data['consent_status'] === undefined
          ? {}
          : {
              consent_status: data['consent_status'] as Exclude<
                RunSessionRow['consent_status'],
                undefined
              >,
            }),
      };
      run.intervention_sessions = [...run.intervention_sessions, session];
      run.run_revision = data['run_revision'] as number;
      // a just-opened session is active, so a strongest mode always exists
      const top = strongestActiveMode(run.intervention_sessions);
      if (top !== undefined) run.intervention_mode = top;
      break;
    }
    case 'intervention.session_closed': {
      const run = must(d.work_runs[data['run_id'] as string], 'work run');
      run.intervention_sessions = run.intervention_sessions.map((x) => {
        if (x.session_id !== data['session_id']) return x;
        const consent = data['consent_status'] as RunSessionRow['consent_status'];
        return {
          ...x,
          ended_at: e.at,
          ...(consent === undefined ? {} : { consent_status: consent }),
        };
      });
      // re-derive the strongest active mode: releasing a takeover must fall
      // back to the strongest remaining session, not keep a stale label
      const top = strongestActiveMode(run.intervention_sessions);
      if (top === undefined) delete run.intervention_mode;
      else run.intervention_mode = top;
      run.run_revision = data['run_revision'] as number;
      if (data['was_takeover'] === true) run.re_equip_required = true;
      break;
    }
    /* v8 ignore next 2 -- unreachable: validateEventLog admits only kernel event types before applyEvent runs */
    default:
      throw new Error(`invalid event: unknown event type ${e.type}`);
  }
  d.seq = e.seq;
  // Version sync + project time — replay path only (see function doc).
  if (d.project !== null) {
    if (STATE_MATERIAL_EVENTS.has(e.type)) {
      d.project.current_state_version = e.state_version;
    }
    d.project.updated_at = e.at;
    d.project.updated_by = e.actor ?? null;
  }
  // Per-row replay time for the touched aggregate row.
  const touch = (row: Draft<Pick<ProjectRow, 'updated_at' | 'updated_by'>> | undefined): void => {
    if (row !== undefined) {
      row.updated_at = e.at;
      row.updated_by = e.actor ?? null;
    }
  };
  switch (e.type) {
    case 'work.created':
    case 'work.redirected':
    case 'work.status_changed':
      touch(d.works[data['work_id'] as string]);
      break;
    case 'asset.created':
      touch(d.assets[(data['asset'] as Record<string, unknown>)['id'] as string]);
      break;
    case 'asset.lifecycle_changed':
    case 'asset.purged':
      touch(d.assets[data['asset_id'] as string]);
      break;
    case 'hold.registered':
    case 'hold.activated':
    case 'hold.resolved':
    case 'hold.accepted':
    case 'hold.dormanted':
    case 'hold.invalidated':
      touch(d.holds[data['hold_id'] as string]);
      break;
    case 'effect.recorded':
    case 'effect.closed':
      touch(d.effects[data['effect_id'] as string]);
      break;
    case 'delivery.recorded':
    case 'delivery.confirmed':
      touch(d.deliveries[data['delivery_id'] as string]);
      break;
    case 'workrun.started':
    case 'workrun.transitioned':
    case 'intervention.session_opened':
    case 'intervention.session_closed':
      touch(d.work_runs[data['run_id'] as string]);
      break;
    case 'direction.proposed':
    case 'direction.resolved':
      touch(d.intended_directions[data['direction_id'] as string]);
      break;
    case 'participant.registered':
    case 'project.created':
    case 'project.boundary_updated':
    case 'project.policy_updated':
    case 'project.status_changed':
    case 'acceptance.recorded':
    case 'checkpoint.created':
    case 'equip.issued':
    case 'equip.budget_exceeded':
    case 'return.absorbed':
    case 'return.rejected':
    case 'return.conflict_marked':
      break;
  }
}

// ---------------------------------------------------------------------------
// Command input shapes
// ---------------------------------------------------------------------------

export interface RegisterParticipantCommand {
  readonly participant_id: string;
  readonly type: 'human' | 'agent';
  readonly display_name?: string;
  readonly at: string;
}

export interface ProposeDirectionCommand {
  readonly actor: string;
  readonly at: string;
  readonly direction_id: string;
  readonly title: string;
  readonly detail?: string;
}

export interface ResolveDirectionCommand {
  readonly actor: string;
  readonly at: string;
  readonly direction_id: string;
  readonly resolution: 'confirmed' | 'discarded';
  readonly resolution_reason: string;
  readonly expected_version: number;
}

export interface StartRunCommand {
  readonly actor: string;
  readonly at: string;
  readonly run_id: string;
  readonly work_id: string;
  readonly equip_id: string;
  readonly parent_run_id?: string;
  readonly execution_refs?: Readonly<Record<string, string>>;
  readonly expected_version: number;
}

export interface TransitionRunCommand {
  readonly actor: string;
  readonly at: string;
  readonly run_id: string;
  readonly to: WorkRunStatus;
  readonly reason: string;
  readonly expected_version: number;
  readonly run_revision: number;
  readonly equip_id?: string;
  readonly input_provided?: string;
  readonly approval_result?: string;
  readonly resume_checkpoint_id?: string;
  readonly checkpoint_reason?: string;
  readonly checkpoint_position?: Readonly<Record<string, unknown>>;
  readonly checkpoint_resume_ref?: Readonly<Record<string, string>>;
}

export interface OpenInterventionCommand {
  readonly actor: string;
  readonly at: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly mode: 'observe' | 'assist' | 'takeover';
  readonly expected_version: number;
  readonly run_revision: number;
}

export interface CloseInterventionCommand {
  readonly actor: string;
  readonly at: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly consent_status?: 'granted' | 'denied';
  readonly expected_version: number;
  readonly run_revision: number;
}

export interface CreateProjectCommand {
  readonly actor: string;
  readonly at: string;
  readonly title: string;
  readonly purpose?: string;
  readonly boundary?: string;
  readonly acceptance_criteria?: readonly string[];
  readonly expected_version: number;
}

export interface UpdateBoundaryCommand {
  readonly actor: string;
  readonly at: string;
  readonly reason: string;
  readonly boundary?: string;
  readonly acceptance_criteria?: readonly string[];
  readonly expected_version: number;
}

export interface UpdatePolicyCommand {
  readonly actor: string;
  readonly at: string;
  readonly reason: string;
  readonly event_count_window?: number;
  readonly time_window_days?: number;
  readonly expected_version: number;
}

export type ProjectTargetStatus = 'paused' | 'active' | 'completed' | 'archived';

export interface SetProjectStatusCommand {
  readonly actor: string;
  readonly at: string;
  readonly reason: string;
  readonly to: ProjectTargetStatus;
  readonly expected_version: number;
}

export interface CreateWorkCommand {
  readonly actor: string;
  readonly at: string;
  readonly reason: string;
  readonly title: string;
  readonly direction?: string;
  readonly expected_version: number;
}

export interface CancelWorkCommand {
  readonly actor: string;
  readonly at: string;
  readonly reason: string;
  readonly work_id: string;
  readonly expected_version: number;
}

export interface RedirectWorkCommand {
  readonly actor: string;
  readonly at: string;
  readonly reason: string;
  readonly work_id: string;
  readonly direction: string;
  readonly create_checkpoint?: boolean;
  readonly expected_version: number;
}

export interface CreateAssetCommand {
  readonly actor: string;
  readonly at: string;
  readonly kind: Asset['kind'];
  readonly scope: Asset['scope'];
  readonly project_id?: string;
  readonly provenance?: string;
  readonly content?: Asset['content'];
  readonly expected_version: number;
}

export interface TransitionAssetCommand {
  readonly actor: string;
  readonly at: string;
  readonly asset_id: string;
  readonly to: AssetLifecycle | 'purged';
  /** Required: retirement is a governed business process, never a silent flip. */
  readonly reason: string;
  readonly double_confirmation?: boolean;
  readonly expected_version: number;
}

export type AcceptanceResult = 'accepted' | 'rejected' | 'conditional';

export interface AcceptAssetCommand {
  readonly actor: string;
  readonly at: string;
  readonly asset_id: string;
  readonly result: AcceptanceResult;
  readonly rationale?: AcceptanceRow['rationale'];
  readonly criteria_snapshot: Readonly<Record<string, unknown>>;
  readonly evidence_refs?: readonly string[];
  readonly expected_version: number;
}

export interface RegisterHoldCommand {
  readonly actor: string;
  readonly at: string;
  readonly kind: string;
  readonly severity: string;
  readonly statement: string;
  readonly blocks_delivery?: boolean;
  readonly asset_refs?: readonly string[];
  // Attribution: the work this hold was raised for. Holds without it are
  // project-wide and appear in every equip (see the equip derivation rule).
  readonly registered_during_work?: string;
  readonly expected_version: number;
}

export interface TransitionHoldCommand {
  readonly actor: string;
  readonly at: string;
  readonly hold_id: string;
  readonly to: HoldStatus;
  readonly reason?: string;
  readonly expected_version: number;
}

export interface RecordEffectCommand {
  readonly actor: string;
  readonly at: string;
  readonly asset_ref?: string;
  readonly description?: string;
  readonly expected_version: number;
}

export interface CloseEffectCommand {
  readonly actor: string;
  readonly at: string;
  readonly effect_id: string;
  readonly outcome: 'confirmed' | 'failed';
  readonly reason?: string;
  readonly expected_version: number;
}

export interface IssueEquipCommand {
  readonly actor: string;
  readonly at: string;
  readonly work_id?: string;
  readonly participant_id?: string;
  readonly allowed_actions?: readonly string[];
  readonly expected_version: number;
}

export interface ReturnCandidateSeed {
  readonly kind: Asset['kind'];
  readonly provenance?: string;
  readonly content?: Asset['content'];
}

export interface ReturnEffectSeed {
  readonly asset_ref?: string;
  readonly description?: string;
}

export interface SubmitReturnCommand {
  readonly actor: string;
  readonly at: string;
  readonly equip_id: string;
  readonly candidates?: readonly ReturnCandidateSeed[];
  readonly effects?: readonly ReturnEffectSeed[];
  /** What the caller had observed when its work happened; absent skips causal judgment. */
  readonly causal_context?: CausalClockSnapshot;
  readonly expected_version: number;
}

export interface DeliverCommand {
  readonly actor: string;
  readonly at: string;
  readonly asset_id: string;
  readonly target_ref: string;
  readonly target_type: string;
  readonly expected_version: number;
}

export interface ConfirmDeliveryCommand {
  readonly actor: string;
  readonly at: string;
  readonly delivery_id: string;
  readonly outcome: 'confirmed' | 'rejected';
  readonly feedback?: string;
  readonly expected_version: number;
}

// ---------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------

export class ProjectStateKernel {
  readonly #history = new EventHistory();
  readonly #draft: MutableProjection = emptyProjection();
  // authoritative causal clock: one component per accepted event, keyed by
  // registered actor; rebuilt identically by replay from authorship
  #causalClock: CausalClockSnapshot = {};
  #projectionView: KernelProjection | undefined;

  /** Read-only view of the live replay-built projection. */
  get projection(): KernelProjection {
    this.#projectionView ??= immutableCopy(this.#draft);
    return this.#projectionView;
  }

  /** Frozen copy of the authoritative causal clock. */
  get causal_clock(): CausalClockSnapshot {
    return deepFreeze({ ...this.#causalClock });
  }

  get stateVersion(): number {
    return this.#draft.project?.current_state_version ?? 0;
  }

  get currentSeq(): number {
    return this.#history.currentSeq;
  }

  /** Immutable view of the full event history. */
  get events(): readonly StateEvent[] {
    return this.#history.all();
  }

  /** Tamper probe: history integrity AND live-vs-rebuilt canonical identity. */
  verifyIntegrity(): { ok: true } | { ok: false; reason: string } {
    const rebuilt = deepFreeze(this.rebuildProjection());
    if (!canonicalEquals(this.#draft, rebuilt)) {
      return { ok: false, reason: 'live projection diverges from replay' };
    }
    return { ok: true };
  }

  /**
   * Full replay into a fresh projection (canonical-JSON equal to the live
   * one). With an optional caller-supplied snapshot (the restore seam of
   * the snapshot capability): when a snapshot is supplied and usable —
   * envelope schema version equality, sequence cursor present in the log,
   * state-version cursor matching the log event's recorded version — the
   * projection is seeded from it and only the events after its sequence
   * cursor are folded, canonically identical to a full fold. Unusable
   * snapshots throw naming the problem: no silent fallback, no silent
   * discard.
   */
  rebuildProjection(snapshot?: ProjectionSnapshot): KernelProjection {
    const events = this.#history.all();
    validateEventLog(events);
    if (snapshot === undefined) {
      const d = emptyProjection();
      for (const e of events) applyEvent(d, e);
      return deepFreeze(d);
    }
    return deepFreeze(restoreThenFold(events, snapshot));
  }

  /** Storage replay path: rebuilds projection and causal clock from a log.
   *  Accepts an optional caller-supplied snapshot with the same restore
   *  contract as `rebuildProjection(snapshot)` (validate, seed, fold the
   *  tail; unusable snapshots throw naming the problem). The snapshot
   *  carries the projection, never the ledger: every event is appended to
   *  the history and every authorship advances the causal clock, while
   *  only the events after the cursor are folded into the seeded state. */
  static fromEvents(
    events: readonly StateEvent[],
    snapshot?: ProjectionSnapshot,
  ): ProjectStateKernel {
    validateEventLog(events);
    const k = new ProjectStateKernel();
    if (snapshot !== undefined) Object.assign(k.#draft, restoreThenFold(events, snapshot));
    for (const event of events) {
      const frozen = k.#history.append(event);
      if (event.actor !== null && event.actor !== undefined)
        k.#causalClock = advanceClock(k.#causalClock, event.actor);
      if (snapshot === undefined) applyEvent(k.#draft, frozen);
    }
    return k;
  }

  // -- commands ------------------------------------------------------------

  /** Typed read of the singleton project row; throws on the impossible empty state. */
  #requireProject(): ProjectRow {
    return must(this.#draft.project, 'project');
  }

  registerParticipant(cmd: RegisterParticipantCommand): KernelResult<ParticipantRow> {
    const invalid = invalidFields('register_participant', [
      ['participant_id', uuidv7Schema, cmd.participant_id],
      ['type', participantTypeSchema, cmd.type],
      ['display_name', participantSchema.shape.display_name, cmd.display_name],
      ['at', instantSchema, cmd.at],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const existing = this.#draft.participants[cmd.participant_id];
    if (existing !== undefined) {
      return {
        ok: false,
        error: kernelErrors.forbidden('register_participant', { reason: 'participant-exists' }),
      };
    }
    this.#append('participant.registered', cmd.at, null, {
      participant_id: cmd.participant_id,
      type: cmd.type,
      ...(cmd.display_name === undefined ? {} : { display_name: cmd.display_name }),
    });
    return success(this.#draft.participants[cmd.participant_id] as ParticipantRow);
  }

  createProject(cmd: CreateProjectCommand): KernelResult<ProjectRow> {
    const invalid = invalidFields('create_project', [
      ['actor', uuidv7Schema, cmd.actor],
      ['at', instantSchema, cmd.at],
      ['title', projectSchema.shape.title, cmd.title],
      ['purpose', textSchema.optional(), cmd.purpose],
      ['boundary', textSchema.optional(), cmd.boundary],
      ['acceptance_criteria', projectSchema.shape.acceptance_criteria, cmd.acceptance_criteria],
      ['expected_version', stateVersionSchema, cmd.expected_version],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const whitespaceField = whitespaceOnlyTextField([
      ['title', cmd.title],
      ['purpose', cmd.purpose],
      ['boundary', cmd.boundary],
      ['acceptance_criteria', cmd.acceptance_criteria],
    ]);
    if (whitespaceField !== undefined) {
      return {
        ok: false,
        error: kernelErrors.forbidden('create_project', {
          reason: 'invalid-fields',
          fields: [whitespaceField],
        }),
      };
    }
    if (this.#draft.project !== null || cmd.expected_version !== 0) {
      return {
        ok: false,
        error: kernelErrors.versionConflict(cmd.expected_version, this.stateVersion),
      };
    }
    const actorGuard = this.#requireKnownActor('create_project', cmd.actor);
    if (actorGuard !== undefined) return actorGuard;
    const projectId = uuidv7();
    this.#append('project.created', cmd.at, cmd.actor, {
      project_id: projectId,
      title: cmd.title,
      ...(cmd.purpose === undefined ? {} : { purpose: cmd.purpose }),
      ...(cmd.boundary === undefined ? {} : { boundary: cmd.boundary }),
      ...(cmd.acceptance_criteria === undefined
        ? {}
        : { acceptance_criteria: [...cmd.acceptance_criteria] }),
    });
    return success(this.#requireProject());
  }

  /**
   * Boundary update — human-only, reason-gated, State-material. Updates
   * the Project's direction fields and marks every equip bound to an
   * older version stale (full invalidation).
   */
  updateBoundary(cmd: UpdateBoundaryCommand): KernelResult<ProjectRow> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'update_boundary',
      cmd.actor,
      cmd.reason,
      true,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('update_boundary', [
      ['at', instantSchema, cmd.at],
      ['boundary', textSchema.optional(), cmd.boundary],
      ['acceptance_criteria', projectSchema.shape.acceptance_criteria, cmd.acceptance_criteria],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    if (cmd.boundary === undefined && cmd.acceptance_criteria === undefined) {
      return { ok: false, error: kernelErrors.forbidden('update_boundary', { reason: 'no-op' }) };
    }
    this.#append('project.boundary_updated', cmd.at, cmd.actor, {
      actor: cmd.actor,
      reason: cmd.reason,
      ...(cmd.boundary === undefined ? {} : { boundary: cmd.boundary }),
      ...(cmd.acceptance_criteria === undefined
        ? {}
        : { acceptance_criteria: [...cmd.acceptance_criteria] }),
    });
    return success(this.#draft.project as ProjectRow);
  }

  /**
   * Updates the capture-window policy row — human-only, reason-gated.
   * The appended event is non-State-material (seq advances, version
   * repeats), so no equip bound to the current version reads as stale
   * across a policy update. At least one window must be present: a no-op
   * update carries no state change and is rejected.
   */
  updatePolicy(cmd: UpdatePolicyCommand): KernelResult<PolicyRow> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'update_policy',
      cmd.actor,
      cmd.reason,
      true,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('update_policy', [
      ['at', instantSchema, cmd.at],
      ['event_count_window', z.number().int().positive().optional(), cmd.event_count_window],
      ['time_window_days', z.number().positive().optional(), cmd.time_window_days],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    if (cmd.event_count_window === undefined && cmd.time_window_days === undefined) {
      return { ok: false, error: kernelErrors.forbidden('update_policy', { reason: 'no-op' }) };
    }
    // capturePolicySchema's bounds are exactly the invalidFields checks above;
    // the field gate is the field constraint's single authority at commands.
    this.#append('project.policy_updated', cmd.at, cmd.actor, {
      actor: cmd.actor,
      reason: cmd.reason,
      ...(cmd.event_count_window === undefined
        ? {}
        : { event_count_window: cmd.event_count_window }),
      ...(cmd.time_window_days === undefined ? {} : { time_window_days: cmd.time_window_days }),
    });
    return success(this.#draft.policy as PolicyRow);
  }

  /**
   * Project status transition — human-only, reason-carrying,
   * non-destructive. Pause from active; resume from paused; complete from
   * active (refused while a blocking hold is active); archive from any
   * live status (cancels incomplete works and invalidates non-resolved
   * holds, each closure event carrying the archive cause).
   */
  setProjectStatus(cmd: SetProjectStatusCommand): KernelResult<ProjectRow> {
    const humanGate = this.#requireHuman('set_project_status', cmd.actor);
    if (!humanGate.ok) return humanGate;
    const invalid = invalidFields('set_project_status', [
      ['actor', uuidv7Schema, cmd.actor],
      ['at', instantSchema, cmd.at],
      ['to', projectStatusSchema, cmd.to],
      ['expected_version', stateVersionSchema, cmd.expected_version],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    if (typeof cmd.reason !== 'string' || cmd.reason.trim().length === 0) {
      return { ok: false, error: kernelErrors.rationaleRequired('set_project_status') };
    }
    const p = this.#draft.project;
    if (p === null) {
      return { ok: false, error: kernelErrors.versionConflict(cmd.expected_version, 0) };
    }
    if (p.current_state_version !== cmd.expected_version) {
      return {
        ok: false,
        error: kernelErrors.versionConflict(cmd.expected_version, p.current_state_version),
      };
    }
    const from = p.status;
    const legal: readonly ProjectTargetStatus[] =
      from === 'active'
        ? ['paused', 'completed', 'archived']
        : from === 'paused'
          ? ['active', 'archived']
          : []; // completed and archived are terminal
    if (!legal.includes(cmd.to)) {
      return {
        ok: false,
        error: kernelErrors.forbidden('set_project_status', {
          from,
          to: cmd.to,
          reason: 'illegal-status-transition',
        }),
      };
    }
    if (cmd.to === 'completed') {
      const blocking = this.#blockingHoldIds();
      if (blocking.length > 0) {
        return { ok: false, error: kernelErrors.blockingHold(blocking) };
      }
    }
    if (cmd.to === 'archived') {
      // Closure cascade runs first, each closure event carrying the cause; the
      // status change lands last and is the State-material version bump.
      const cause = `project archive: ${cmd.reason}`;
      for (const w of Object.values(this.#draft.works)) {
        if (!alive(w) || w.status === 'completed' || w.status === 'cancelled') continue;
        this.#append('work.status_changed', cmd.at, cmd.actor, {
          work_id: w.id,
          from: w.status,
          to: 'cancelled',
          reason: cause,
          cause: 'project_archived',
          actor: cmd.actor,
        });
      }
      for (const h of Object.values(this.#draft.holds)) {
        if (!alive(h) || (h.status !== 'registered' && h.status !== 'active')) continue;
        this.#append(HOLD_EVENT_TYPE.invalidated, cmd.at, cmd.actor, {
          hold_id: h.id,
          from: h.status,
          to: 'invalidated',
          actor: cmd.actor,
          reason: cause,
          cause: 'project_archived',
        });
      }
    }
    this.#append('project.status_changed', cmd.at, cmd.actor, {
      actor: cmd.actor,
      from,
      to: cmd.to,
      reason: cmd.reason,
    });
    return success(this.#draft.project as ProjectRow);
  }

  createWork(cmd: CreateWorkCommand): KernelResult<WorkRow> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'create_work',
      cmd.actor,
      cmd.reason,
      true,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('create_work', [
      ['at', instantSchema, cmd.at],
      ['title', workSchema.shape.title, cmd.title],
      ['direction', textSchema.optional(), cmd.direction],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const whitespaceField = whitespaceOnlyTextField([
      ['title', cmd.title],
      ['reason', cmd.reason],
      ['direction', cmd.direction],
    ]);
    if (whitespaceField !== undefined) {
      return {
        ok: false,
        error: kernelErrors.forbidden('create_work', {
          reason: 'invalid-fields',
          fields: [whitespaceField],
        }),
      };
    }
    const workId = uuidv7();
    const projectId = this.#requireProject().id;
    this.#append('work.created', cmd.at, cmd.actor, {
      work_id: workId,
      project_id: projectId,
      title: cmd.title,
      reason: cmd.reason,
      ...(cmd.direction === undefined ? {} : { direction: cmd.direction }),
      actor: cmd.actor,
    });
    return success(this.#draft.works[workId] as WorkRow);
  }

  cancelWork(cmd: CancelWorkCommand): KernelResult<WorkRow> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'cancel_work',
      cmd.actor,
      cmd.reason,
      true,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('cancel_work', [
      ['at', instantSchema, cmd.at],
      ['work_id', uuidv7Schema, cmd.work_id],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const w = this.#draft.works[cmd.work_id];
    if (w === undefined || !alive(w)) {
      return {
        ok: false,
        error: kernelErrors.forbidden('cancel_work', { reason: 'work-not-found' }),
      };
    }
    if (w.status === 'completed' || w.status === 'cancelled') {
      return {
        ok: false,
        error: kernelErrors.forbidden('cancel_work', {
          reason: 'work-already-terminal',
          status: w.status,
        }),
      };
    }
    this.#append('work.status_changed', cmd.at, cmd.actor, {
      work_id: cmd.work_id,
      from: w.status,
      to: 'cancelled',
      reason: cmd.reason,
      actor: cmd.actor,
    });
    return success(this.#draft.works[cmd.work_id] as WorkRow);
  }

  /**
   * Work redirection — human-gated, reason-carrying; updates only
   * Work.direction and creates a Checkpoint (default on). A method
   * correction is NOT a boundary change: seq and the Work aggregate
   * revision advance while project_state_version stays unchanged.
   */
  redirectWork(cmd: RedirectWorkCommand): KernelResult<WorkRow> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'redirect_work',
      cmd.actor,
      cmd.reason,
      true,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('redirect_work', [
      ['at', instantSchema, cmd.at],
      ['work_id', uuidv7Schema, cmd.work_id],
      ['direction', textSchema, cmd.direction],
      ['create_checkpoint', z.boolean().optional(), cmd.create_checkpoint],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const whitespaceField = whitespaceOnlyTextField([['direction', cmd.direction]]);
    if (whitespaceField !== undefined) {
      return {
        ok: false,
        error: kernelErrors.forbidden('redirect_work', {
          reason: 'invalid-fields',
          fields: [whitespaceField],
        }),
      };
    }
    const w = this.#draft.works[cmd.work_id];
    if (w === undefined || !alive(w)) {
      return {
        ok: false,
        error: kernelErrors.forbidden('redirect_work', { reason: 'work-not-found' }),
      };
    }
    const withCheckpoint = cmd.create_checkpoint ?? true;
    this.#append('work.redirected', cmd.at, cmd.actor, {
      work_id: cmd.work_id,
      direction: cmd.direction,
      reason: cmd.reason,
      actor: cmd.actor,
      ...(withCheckpoint
        ? {
            checkpoint: {
              id: uuidv7(),
              reason: cmd.reason,
              position: { work_id: cmd.work_id, redirected_to: cmd.direction },
            },
          }
        : {}),
    });
    return success(this.#draft.works[cmd.work_id] as WorkRow);
  }

  /** Candidate asset creation — the artifact enters as a proposal, never active. */
  createAsset(cmd: CreateAssetCommand): KernelResult<AssetRow> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'create_asset',
      cmd.actor,
      null,
      false,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('create_asset', [
      ['at', instantSchema, cmd.at],
      ['project_id', uuidv7Schema.optional(), cmd.project_id],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const assetId = uuidv7();
    const projectId = this.#requireProject().id;
    if (cmd.project_id !== undefined && cmd.project_id !== projectId) {
      return {
        ok: false,
        error: kernelErrors.forbidden('create_asset', { reason: 'project-mismatch' }),
      };
    }
    const asset = assetSchema.safeParse({
      id: assetId,
      kind: cmd.kind,
      scope: cmd.scope,
      lifecycle: 'candidate',
      created_at: cmd.at,
      ...(cmd.scope === 'organization' ? {} : { project_id: projectId }),
      ...(cmd.provenance === undefined ? {} : { provenance: cmd.provenance }),
      ...(cmd.content === undefined ? {} : { content: cmd.content }),
    });
    if (!asset.success) {
      return {
        ok: false,
        error: kernelErrors.forbidden('create_asset', {
          reason: 'invalid-asset',
          fields: asset.error.issues.map((issue) => issue.path.join('.')),
        }),
      };
    }
    this.#append('asset.created', cmd.at, cmd.actor, {
      asset: asset.data,
      actor: cmd.actor,
    });
    return success(this.#draft.assets[assetId] as AssetRow);
  }

  /**
   * Lifecycle transition through the schema machine's legal-pair table.
   * competitive_superseded→active additionally honors the grace window;
   * archived→purged requires the double condition
   * and lands as a retirement tombstone.
   */
  transitionAsset(cmd: TransitionAssetCommand): KernelResult<AssetRow> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'transition_asset',
      cmd.actor,
      cmd.reason,
      true,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('transition_asset', [
      ['at', instantSchema, cmd.at],
      ['asset_id', uuidv7Schema, cmd.asset_id],
      ['to', z.union([assetSchema.shape.lifecycle, z.literal('purged')]), cmd.to],
      ['double_confirmation', z.boolean().optional(), cmd.double_confirmation],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const a = this.#draft.assets[cmd.asset_id];
    if (a === undefined || !alive(a)) {
      return {
        ok: false,
        error: kernelErrors.forbidden('transition_asset', { reason: 'asset-not-found' }),
      };
    }
    if (a.lifecycle === 'candidate' && (cmd.to === 'active' || cmd.to === 'rejected')) {
      return {
        ok: false,
        error: kernelErrors.forbidden('transition_asset', { reason: 'acceptance-required' }),
      };
    }
    if (cmd.to === 'active' && a.lifecycle === 'competitive_superseded') {
      // Invariant: applyEvent stamps competitive_superseded_at on supersede and
      // clears it on every other lifecycle, so a superseded row always has one.
      const days = this.#daysBetween(must(a.competitive_superseded_at, 'superseded-at'), cmd.at);
      if (days > COMPETITIVE_GRACE_PERIOD_DAYS) {
        return {
          ok: false,
          error: {
            module: 'schema',
            code: 'illegal-transition',
            urn: 'schema/illegal-transition',
            details: {
              from: a.lifecycle,
              to: cmd.to,
              grace_days: COMPETITIVE_GRACE_PERIOD_DAYS,
              days_elapsed: days,
            },
          },
        };
      }
    }
    const purgeGate =
      cmd.to === 'purged'
        ? {
            daysArchived:
              a.archived_at === undefined ? 0 : this.#daysBetween(a.archived_at, cmd.at),
            doubleConfirmation: cmd.double_confirmation ?? false,
          }
        : undefined;
    const verdict = assertTransition(a.lifecycle, cmd.to as AssetLifecycle, purgeGate);
    if (!verdict.ok) return { ok: false, error: verdict.error };
    if (cmd.to === 'purged') {
      this.#append('asset.purged', cmd.at, cmd.actor, {
        asset_id: cmd.asset_id,
        from: a.lifecycle,
        to: 'purged',
        reason: cmd.reason,
        actor: cmd.actor,
      });
    } else {
      this.#append('asset.lifecycle_changed', cmd.at, cmd.actor, {
        asset_id: cmd.asset_id,
        from: a.lifecycle,
        to: cmd.to,
        reason: cmd.reason,
        actor: cmd.actor,
      });
    }
    return success(this.#draft.assets[cmd.asset_id] as AssetRow);
  }

  /**
   * Acceptance — a named human verdict (the schema module notes the
   * human-only rule is enforced above it; this is that layer).
   * rejected/conditional require a written rationale (mirroring the
   * schema's refine; zero pollution on rejection). accepted drives the
   * implied lifecycle transition through the legal-pair table; conditional
   * records the verdict and keeps the candidate (a later acceptance can
   * promote it).
   */
  acceptAsset(cmd: AcceptAssetCommand): KernelResult<{ asset: AssetRow; acceptance_id: string }> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'accept_asset',
      cmd.actor,
      null,
      true,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('accept_asset', [
      ['at', instantSchema, cmd.at],
      ['asset_id', uuidv7Schema, cmd.asset_id],
      ['result', acceptanceResultSchema, cmd.result],
      ['rationale', textSchema.nullable().optional(), cmd.rationale],
      ['criteria_snapshot', jsonRecordSchema, cmd.criteria_snapshot],
      ['evidence_refs', uuidListSchema.optional(), cmd.evidence_refs],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const a = this.#draft.assets[cmd.asset_id];
    if (a === undefined || !alive(a)) {
      return {
        ok: false,
        error: kernelErrors.forbidden('accept_asset', { reason: 'asset-not-found' }),
      };
    }
    if (
      (cmd.result === 'rejected' || cmd.result === 'conditional') &&
      (typeof cmd.rationale !== 'string' || cmd.rationale.trim().length === 0)
    ) {
      return { ok: false, error: kernelErrors.rationaleRequired('accept_asset') };
    }
    if (a.lifecycle !== 'candidate') {
      return {
        ok: false,
        error: kernelErrors.forbidden('accept_asset', {
          reason: 'asset-not-candidate',
          lifecycle: a.lifecycle,
        }),
      };
    }
    // The Acceptance object schema's cross-field rule (rationale on
    // rejected/conditional) is enforced explicitly above; every other field
    // was validated by invalidFields, and parseEventData re-checks the shape
    // at append. A second whole-object parse here would re-state the same
    // constraints without adding a check.
    for (const evidenceId of cmd.evidence_refs ?? []) {
      const evidence = this.#draft.assets[evidenceId];
      if (evidence === undefined || !alive(evidence) || evidence.kind !== 'evidence') {
        return {
          ok: false,
          error: kernelErrors.forbidden('accept_asset', {
            reason: 'evidence-not-found',
            evidence_id: evidenceId,
          }),
        };
      }
    }
    const acceptanceId = uuidv7();
    this.#append('acceptance.recorded', cmd.at, cmd.actor, {
      acceptance_id: acceptanceId,
      asset_id: cmd.asset_id,
      result: cmd.result,
      actor: cmd.actor,
      ...(cmd.rationale === undefined ? {} : { rationale: cmd.rationale }),
      criteria_snapshot: cmd.criteria_snapshot,
      ...(cmd.evidence_refs === undefined ? {} : { evidence_refs: [...cmd.evidence_refs] }),
    });
    if (cmd.result === 'accepted') {
      this.#append('asset.lifecycle_changed', cmd.at, cmd.actor, {
        asset_id: cmd.asset_id,
        from: 'candidate',
        to: 'active',
        reason: 'accepted',
        actor: cmd.actor,
      });
    } else if (cmd.result === 'rejected') {
      this.#append('asset.lifecycle_changed', cmd.at, cmd.actor, {
        asset_id: cmd.asset_id,
        from: 'candidate',
        to: 'rejected',
        reason: cmd.rationale,
        actor: cmd.actor,
      });
    }
    return success({
      asset: this.#draft.assets[cmd.asset_id] as AssetRow,
      acceptance_id: acceptanceId,
    });
  }

  /**
   * Hold registration — ai-proposes-human-enacts. An agent-registered hold
   * starts `registered` and blocks nothing; a human-registered hold is
   * `active` immediately. Every hold event's data carries the acting
   * Participant id.
   */
  registerHold(cmd: RegisterHoldCommand): KernelResult<HoldRow> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'register_hold',
      cmd.actor,
      null,
      false,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('register_hold', [
      ['at', instantSchema, cmd.at],
      ['kind', holdKindSchema, cmd.kind],
      ['severity', holdSeveritySchema, cmd.severity],
      ['statement', textSchema, cmd.statement],
      ['blocks_delivery', z.boolean().optional(), cmd.blocks_delivery],
      ['asset_refs', uuidListSchema.optional(), cmd.asset_refs],
      ['registered_during_work', uuidv7Schema.optional(), cmd.registered_during_work],
    ]);
    if (typeof cmd.statement === 'string' && cmd.statement.trim().length === 0) {
      return { ok: false, error: kernelErrors.rationaleRequired('register_hold') };
    }
    if (invalid !== undefined) return { ok: false, error: invalid };
    const initialStatus: HoldStatus =
      this.#draft.participants[cmd.actor]?.type === 'human' ? 'active' : 'registered';
    const holdId = uuidv7();
    const projectId = this.#requireProject().id;
    // Every input reaching the event already passed invalidFields, and
    // RegisterHoldCommand exposes no fields outside those checks: the hold's
    // own schema is re-applied by parseEventData at append, which is the
    // single authority for the object's field constraints on the event path.
    for (const assetId of cmd.asset_refs ?? []) {
      const asset = this.#draft.assets[assetId];
      if (asset === undefined || !alive(asset)) {
        return {
          ok: false,
          error: kernelErrors.forbidden('register_hold', {
            reason: 'asset-not-found',
            asset_id: assetId,
          }),
        };
      }
    }
    this.#append('hold.registered', cmd.at, cmd.actor, {
      hold_id: holdId,
      project_id: projectId,
      kind: cmd.kind,
      severity: cmd.severity,
      initial_status: initialStatus,
      blocks_delivery: cmd.blocks_delivery ?? false,
      statement: cmd.statement,
      registered_by: cmd.actor,
      actor: cmd.actor,
      ...(cmd.asset_refs === undefined ? {} : { asset_refs: [...cmd.asset_refs] }),
      ...(cmd.registered_during_work === undefined
        ? {}
        : { registered_during_work: cmd.registered_during_work }),
    });
    return success(this.#draft.holds[holdId] as HoldRow);
  }

  /** Hold lifecycle transition through the baseline table (confirm/close/reactivate). */
  transitionHold(cmd: TransitionHoldCommand): KernelResult<HoldRow> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'transition_hold',
      cmd.actor,
      null,
      false,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('transition_hold', [
      ['at', instantSchema, cmd.at],
      ['hold_id', uuidv7Schema, cmd.hold_id],
      ['to', holdStatusSchema, cmd.to],
      ['reason', textSchema.optional(), cmd.reason],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const h = this.#draft.holds[cmd.hold_id];
    if (h === undefined || !alive(h)) {
      return {
        ok: false,
        error: kernelErrors.forbidden('transition_hold', { reason: 'hold-not-found' }),
      };
    }
    const rule = HOLD_TRANSITIONS[h.status].find((t) => t.to === cmd.to);
    if (rule === undefined) {
      return {
        ok: false,
        error: kernelErrors.forbidden('transition_hold', {
          from: h.status,
          to: cmd.to,
          reason: 'illegal-hold-transition',
        }),
      };
    }
    if (rule.humanOnly) {
      const humanGate = this.#requireHuman('transition_hold', cmd.actor);
      if (!humanGate.ok) return humanGate;
    }
    if (rule.reasonRequired && (cmd.reason === undefined || cmd.reason.trim().length === 0)) {
      return { ok: false, error: kernelErrors.rationaleRequired('transition_hold') };
    }
    this.#append(HOLD_EVENT_TYPE[cmd.to], cmd.at, cmd.actor, {
      hold_id: cmd.hold_id,
      from: h.status,
      to: cmd.to,
      actor: cmd.actor,
      ...(cmd.reason === undefined ? {} : { reason: cmd.reason }),
    });
    return success(this.#draft.holds[cmd.hold_id] as HoldRow);
  }

  /** Effect ledger entry — starts `unknown` (an unclosed unknown blocks delivery). */
  recordEffect(cmd: RecordEffectCommand): KernelResult<EffectRow> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'record_effect',
      cmd.actor,
      null,
      false,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('record_effect', [
      ['at', instantSchema, cmd.at],
      ['asset_ref', uuidv7Schema.optional(), cmd.asset_ref],
      ['description', textSchema.optional(), cmd.description],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const effectId = uuidv7();
    this.#append('effect.recorded', cmd.at, cmd.actor, {
      effect_id: effectId,
      actor: cmd.actor,
      ...(cmd.asset_ref === undefined ? {} : { asset_ref: cmd.asset_ref }),
      ...(cmd.description === undefined ? {} : { description: cmd.description }),
    });
    return success(this.#draft.effects[effectId] as EffectRow);
  }

  /**
   * Close an effect: unknown→confirmed (it happened) or unknown→failed
   * (it did not). Closure is not success — the ledger equals reality
   * either way; both close states unblock delivery.
   */
  closeEffect(cmd: CloseEffectCommand): KernelResult<EffectRow> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'close_effect',
      cmd.actor,
      null,
      false,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('close_effect', [
      ['at', instantSchema, cmd.at],
      ['effect_id', uuidv7Schema, cmd.effect_id],
      ['outcome', z.enum(['confirmed', 'failed']), cmd.outcome],
      ['reason', textSchema.optional(), cmd.reason],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const ef = this.#draft.effects[cmd.effect_id];
    if (ef === undefined || !alive(ef)) {
      return {
        ok: false,
        error: kernelErrors.forbidden('close_effect', { reason: 'effect-not-found' }),
      };
    }
    if (ef.status !== 'unknown') {
      return {
        ok: false,
        error: kernelErrors.forbidden('close_effect', {
          reason: 'effect-already-closed',
          status: ef.status,
        }),
      };
    }
    this.#append('effect.closed', cmd.at, cmd.actor, {
      effect_id: cmd.effect_id,
      outcome: cmd.outcome,
      actor: cmd.actor,
      ...(cmd.reason === undefined ? {} : { reason: cmd.reason }),
    });
    return success(this.#draft.effects[cmd.effect_id] as EffectRow);
  }

  /**
   * Equip issuance — a derived contract, never stored as business data.
   * The ledger records the issuance fact (identity + version binding) so
   * staleness and wholesale return rejection are replayable; the fact
   * payload below is assembled at request time. Exceeding the serialized
   * fact budget fails explicitly with a diagnostics event.
   */
  issueEquip(cmd: IssueEquipCommand): KernelResult<IssuedEquip> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'issue_equip',
      cmd.actor,
      null,
      false,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('issue_equip', [
      ['at', instantSchema, cmd.at],
      ['work_id', uuidv7Schema.optional(), cmd.work_id],
      ['participant_id', uuidv7Schema.optional(), cmd.participant_id],
      [
        'allowed_actions',
        z.array(z.string().min(1).max(128)).max(100).optional(),
        cmd.allowed_actions,
      ],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    if (cmd.work_id !== undefined) {
      const work = this.#draft.works[cmd.work_id];
      if (work === undefined || !alive(work) || work.status === 'cancelled') {
        return {
          ok: false,
          error: kernelErrors.forbidden('issue_equip', {
            reason: 'work-not-found',
            work_id: cmd.work_id,
          }),
        };
      }
    }
    const participantId = cmd.participant_id ?? cmd.actor;
    const participantGuard = this.#requireKnownActor('issue_equip', participantId);
    if (participantGuard !== undefined) return participantGuard;
    const version = this.stateVersion;
    const verifiedFacts = Object.values(this.#draft.assets)
      .filter((a) => alive(a) && scopeVisibleForProject(a.scope) && a.lifecycle === 'active')
      .map((a) => a.id);
    const serialized = new TextEncoder().encode(JSON.stringify(verifiedFacts)).length;
    if (serialized > EQUIP_SIZE_BUDGET) {
      this.#append('equip.budget_exceeded', cmd.at, cmd.actor, {
        ...(cmd.work_id === undefined ? {} : { work_id: cmd.work_id }),
        participant_id: participantId,
        fact_count: verifiedFacts.length,
        serialized_length: serialized,
        budget: EQUIP_SIZE_BUDGET,
        actor: cmd.actor,
      });
      return {
        ok: false,
        error: kernelErrors.equipBudgetExceeded(
          verifiedFacts.length,
          serialized,
          EQUIP_SIZE_BUDGET,
        ),
      };
    }
    const equipId = uuidv7();
    const causalSnapshot = this.causal_clock;
    this.#append('equip.issued', cmd.at, cmd.actor, {
      equip_id: equipId,
      state_version: version,
      actor: cmd.actor,
      // bootstrap: a joiner starts from the authoritative observation; the
      // copy decouples the payload from the live clock object
      causal_snapshot: causalSnapshot,
      ...(cmd.work_id === undefined ? {} : { work_id: cmd.work_id }),
      participant_id: participantId,
      ...(cmd.allowed_actions === undefined ? {} : { allowed_actions: [...cmd.allowed_actions] }),
    });
    const p = this.#draft.project as ProjectRow;
    return success({
      id: equipId,
      ...(cmd.work_id === undefined ? {} : { work_id: cmd.work_id }),
      participant_id: participantId,
      state_version: version,
      causal_snapshot: causalSnapshot,
      verified_facts: verifiedFacts,
      active_assets: Object.values(this.#draft.assets)
        .filter(
          (a) =>
            alive(a) &&
            scopeVisibleForProject(a.scope) &&
            (a.lifecycle === 'active' || a.lifecycle === 'candidate'),
        )
        .map((a) => a.id),
      // Unattributed holds are project-wide and bind every work; narrowing the
      // filter must never silence them.
      active_holds: Object.values(this.#draft.holds)
        .filter(
          (h) =>
            alive(h) &&
            h.status === 'active' &&
            (h.registered_during_work === undefined ||
              (cmd.work_id !== undefined && h.registered_during_work === cmd.work_id)),
        )
        .map((h) => h.id),
      ...(p.boundary === undefined ? {} : { boundary: p.boundary }),
      ...(p.acceptance_criteria === undefined
        ? {}
        : { acceptance_criteria: p.acceptance_criteria }),
      ...(cmd.allowed_actions === undefined ? {} : { allowed_actions: cmd.allowed_actions }),
      issued_at: cmd.at,
      status: 'active',
    });
  }

  /**
   * Return submission against an equip. A return bound to a stale equip
   * version (or a stale-marked equip) is rejected WHOLESALE: a
   * return-rejected event is recorded and none of its candidates or
   * effects enter the projection.
   */
  submitReturn(
    cmd: SubmitReturnCommand,
  ): KernelResult<{ absorbed_candidates: number; absorbed_effects: number }> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'submit_return',
      cmd.actor,
      null,
      false,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('submit_return', [
      ['at', instantSchema, cmd.at],
      ['equip_id', uuidv7Schema, cmd.equip_id],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const candidatesInput = z.array(z.unknown()).safeParse(cmd.candidates ?? []);
    if (!candidatesInput.success) {
      return {
        ok: false,
        error: kernelErrors.forbidden('submit_return', {
          reason: 'invalid-candidates',
          fields: candidatesInput.error.issues.map((issue) => issue.path.join('.')),
        }),
      };
    }
    // a malformed or foreign snapshot rejects before anything is appended
    let context: CausalClockSnapshot | undefined;
    if (cmd.causal_context !== undefined) {
      const parsed = causalClockSnapshotSchema.safeParse(cmd.causal_context);
      if (!parsed.success) {
        return {
          ok: false,
          error: kernelErrors.causalContextInvalid('malformed snapshot'),
        };
      }
      for (const key of Object.keys(parsed.data)) {
        if (this.#draft.participants[key] === undefined) {
          return { ok: false, error: kernelErrors.causalActorUnregistered(key) };
        }
      }
      context = parsed.data;
    }
    // Judgment happens at return time against the then-authoritative clock.
    const verdict = context === undefined ? undefined : compareClocks(context, this.#causalClock);
    const equip = this.#draft.equips[cmd.equip_id];
    const current = this.stateVersion;
    if (equip !== undefined && equip.participant_id !== cmd.actor) {
      return {
        ok: false,
        error: kernelErrors.forbidden('submit_return', { reason: 'foreign-equip' }),
      };
    }
    if (equip?.status !== 'active' || equip.state_version !== current) {
      this.#append('return.rejected', cmd.at, cmd.actor, {
        equip_id: cmd.equip_id,
        actor: cmd.actor,
        equip_state_version: equip === undefined ? null : equip.state_version,
        equip_status: equip === undefined ? 'unknown-equip' : equip.status,
        current_state_version: current,
        candidate_count: cmd.candidates?.length ?? 0,
        effect_count: cmd.effects?.length ?? 0,
        ...(verdict === undefined ? {} : { verdict }),
        ...(context === undefined ? {} : { causal_context: context }),
        ...(verdict === undefined ? {} : { authoritative_clock: { ...this.#causalClock } }),
      });
      return {
        ok: false,
        error: kernelErrors.versionConflict(equip?.state_version ?? current, current),
      };
    }
    const candidates: Asset[] = [];
    for (const seed of candidatesInput.data) {
      if (typeof seed !== 'object' || seed === null) {
        return {
          ok: false,
          error: kernelErrors.forbidden('submit_return', {
            reason: 'invalid-candidate',
            fields: ['candidate'],
          }),
        };
      }
      const input = seed as Record<string, unknown>;
      const candidateInput = z
        .strictObject({
          kind: assetSchema.shape.kind,
          provenance: textSchema.optional(),
          content: assetSchema.shape.content,
        })
        .safeParse(input);
      if (!candidateInput.success) {
        return {
          ok: false,
          error: kernelErrors.forbidden('submit_return', {
            reason: 'invalid-candidate',
            fields: candidateInput.error.issues.map((issue) => issue.path.join('.')),
          }),
        };
      }
      const candidateSeed = candidateInput.data;
      const candidate = assetSchema.parse({
        id: uuidv7(),
        kind: candidateSeed.kind,
        scope: 'project',
        project_id: this.#requireProject().id,
        lifecycle: 'candidate',
        created_at: cmd.at,
        ...(candidateSeed.provenance === undefined ? {} : { provenance: candidateSeed.provenance }),
        ...(candidateSeed.content === undefined ? {} : { content: candidateSeed.content }),
      });
      candidates.push(candidate);
    }
    const effectsInput = z
      .array(
        z.strictObject({
          asset_ref: uuidv7Schema.optional(),
          description: textSchema.optional(),
        }),
      )
      .safeParse(cmd.effects ?? []);
    if (!effectsInput.success) {
      return {
        ok: false,
        error: kernelErrors.forbidden('submit_return', {
          reason: 'invalid-effects',
          fields: effectsInput.error.issues.map((issue) => issue.path.join('.')),
        }),
      };
    }
    const effects = effectsInput.data.map((seed) => ({
      id: uuidv7(),
      ...(seed.asset_ref === undefined ? {} : { asset_ref: seed.asset_ref }),
      ...(seed.description === undefined ? {} : { description: seed.description }),
    }));
    // concurrent: absorb but mark for human review in the same transaction —
    // the clock never resolves content
    const conflictMarked = verdict === 'concurrent';
    this.#append('return.absorbed', cmd.at, cmd.actor, {
      equip_id: cmd.equip_id,
      actor: cmd.actor,
      candidates,
      effects,
      ...(verdict === undefined ? {} : { verdict }),
      ...(context === undefined ? {} : { causal_context: context }),
      ...(verdict === undefined ? {} : { authoritative_clock: { ...this.#causalClock } }),
    });
    if (conflictMarked) {
      this.#append('return.conflict_marked', cmd.at, cmd.actor, {
        return_actor: cmd.actor,
        verdict,
        causal_context: context,
        authoritative_clock: { ...this.#causalClock },
      });
    }
    return {
      ok: true,
      value: { absorbed_candidates: candidates.length, absorbed_effects: effects.length },
    };
  }

  /**
   * Delivery — a promise to the physical world, gated in the fixed order:
   * project not active → unaccepted artifact → blocking hold → unclosed
   * unknown effect. One OPEN attempt per (asset, target): a retry after
   * the business side rejects is a new attempt (attempt_no advances), but
   * never while one is open. Success appends a delivered event carrying
   * the delivering Participant id and the asset's content sha256 anchor.
   */
  deliver(cmd: DeliverCommand): KernelResult<DeliveryRow> {
    const gate = this.#guardPreconditions(cmd.expected_version, 'deliver', cmd.actor, null, false);
    if (!gate.ok) return gate;
    const invalid = invalidFields('deliver', [
      ['at', instantSchema, cmd.at],
      ['asset_id', uuidv7Schema, cmd.asset_id],
      ['target_ref', z.string().min(1).max(512), cmd.target_ref],
      ['target_type', deliveryTargetTypeSchema, cmd.target_type],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const whitespaceField = whitespaceOnlyTextField([['target_ref', cmd.target_ref]]);
    if (whitespaceField !== undefined) {
      return {
        ok: false,
        error: kernelErrors.forbidden('deliver', {
          reason: 'invalid-fields',
          fields: [whitespaceField],
        }),
      };
    }
    const a = this.#draft.assets[cmd.asset_id];
    if (
      a === undefined ||
      !alive(a) ||
      a.lifecycle !== 'active' ||
      !Object.values(this.#draft.acceptances).some(
        (acceptance) =>
          alive(acceptance) &&
          acceptance.asset_id === cmd.asset_id &&
          acceptance.result === 'accepted',
      )
    ) {
      return {
        ok: false,
        error: kernelErrors.unacceptedArtifact(cmd.asset_id, a?.lifecycle ?? 'unknown'),
      };
    }
    if (a.content?.sha256 === undefined) {
      // The delivery row's version anchor is the asset's content sha256;
      // an accepted artifact without one is not deliverable.
      return {
        ok: false,
        error: kernelErrors.forbidden('deliver', {
          reason: 'missing-content-sha256',
          asset_id: cmd.asset_id,
        }),
      };
    }
    const blocking = Object.values(this.#draft.holds).filter(
      (h) =>
        alive(h) &&
        h.status === 'active' &&
        h.blocks_delivery &&
        (h.asset_refs ?? []).includes(cmd.asset_id),
    );
    if (blocking.length > 0) {
      return { ok: false, error: kernelErrors.blockingHold(blocking.map((h) => h.id)) };
    }
    const unknownEffects = Object.values(this.#draft.effects).filter(
      (ef) => alive(ef) && ef.status === 'unknown' && ef.asset_ref === cmd.asset_id,
    );
    if (unknownEffects.length > 0) {
      return {
        ok: false,
        error: kernelErrors.unknownEffectUnclosed(unknownEffects.map((ef) => ef.id)),
      };
    }
    const prior = Object.values(this.#draft.deliveries).filter(
      (d) => alive(d) && d.asset_id === cmd.asset_id && d.target_ref === cmd.target_ref,
    );
    const open = prior.find(
      (d) => d.confirmation_status === 'delivered' || d.confirmation_status === 'pending',
    );
    if (open !== undefined) {
      return {
        ok: false,
        error: kernelErrors.openAttemptExists(cmd.asset_id, cmd.target_ref, open.attempt_no),
      };
    }
    const deliveryId = uuidv7();
    this.#append('delivery.recorded', cmd.at, cmd.actor, {
      delivery_id: deliveryId,
      asset_id: cmd.asset_id,
      target_ref: cmd.target_ref,
      target_type: cmd.target_type,
      version: a.content.sha256,
      attempt_no: prior.length + 1,
      delivered_by: cmd.actor,
      actor: cmd.actor,
    });
    return success(this.#draft.deliveries[deliveryId] as DeliveryRow);
  }

  /**
   * Business-side delivery confirmation — the real world's answer to the
   * promise. confirmed closes the delivery; rejected is terminal for the
   * attempt and frees the (asset, target) slot for a retry attempt.
   */
  confirmDelivery(cmd: ConfirmDeliveryCommand): KernelResult<DeliveryRow> {
    const gate = this.#guardPreconditions(
      cmd.expected_version,
      'confirm_delivery',
      cmd.actor,
      null,
      false,
    );
    if (!gate.ok) return gate;
    const invalid = invalidFields('confirm_delivery', [
      ['at', instantSchema, cmd.at],
      ['delivery_id', uuidv7Schema, cmd.delivery_id],
      ['outcome', z.enum(['confirmed', 'rejected']), cmd.outcome],
      ['feedback', textSchema.optional(), cmd.feedback],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const dl = this.#draft.deliveries[cmd.delivery_id];
    if (dl === undefined || !alive(dl)) {
      return {
        ok: false,
        error: kernelErrors.forbidden('confirm_delivery', { reason: 'delivery-not-found' }),
      };
    }
    if (dl.confirmation_status !== 'delivered' && dl.confirmation_status !== 'pending') {
      return {
        ok: false,
        error: kernelErrors.forbidden('confirm_delivery', {
          reason: 'delivery-already-terminal',
          status: dl.confirmation_status,
        }),
      };
    }
    this.#append('delivery.confirmed', cmd.at, cmd.actor, {
      delivery_id: cmd.delivery_id,
      outcome: cmd.outcome,
      confirmed_by: cmd.actor,
      actor: cmd.actor,
      ...(cmd.feedback === undefined ? {} : { feedback: cmd.feedback }),
    });
    return success(this.#draft.deliveries[cmd.delivery_id] as DeliveryRow);
  }

  // -- private helpers -----------------------------------------------------

  /**
   * Project-version checks protect the business context used by a command.
   * Ordinary events do not advance that version; persistence checks append
   * concurrency separately against the ledger sequence.
   */
  #guardPreconditions(
    expectedVersion: number,
    action: string,
    actor: string,
    reason: string | null,
    humanOnly: boolean,
  ): KernelResult<void> {
    const participant = this.#draft.participants[actor];
    if (!Object.hasOwn(this.#draft.participants, actor) || participant === undefined) {
      return { ok: false, error: kernelErrors.forbidden(action, { reason: 'unknown-actor' }) };
    }
    const p = this.#draft.project;
    if (p === null) {
      return { ok: false, error: kernelErrors.versionConflict(expectedVersion, 0) };
    }
    if (p.current_state_version !== expectedVersion) {
      return {
        ok: false,
        error: kernelErrors.versionConflict(expectedVersion, p.current_state_version),
      };
    }
    const needsActive =
      action === 'update_boundary' ||
      action === 'issue_equip' ||
      action === 'submit_return' ||
      action === 'deliver';
    if (needsActive && p.status !== 'active') {
      return { ok: false, error: kernelErrors.projectNotActive(p.status, action) };
    }
    const actorType = participant.type;
    if (humanOnly && actorType !== 'human') {
      return {
        ok: false,
        error: kernelErrors.forbidden(action, { actor_kind: actorType }),
      };
    }
    if (reason !== null && (typeof reason !== 'string' || reason.trim().length === 0)) {
      return { ok: false, error: kernelErrors.rationaleRequired(action) };
    }
    return { ok: true, value: undefined };
  }

  #requireKnownActor(
    action: string,
    actor: string,
  ): { readonly ok: false; readonly error: KernelError } | undefined {
    if (!Object.hasOwn(this.#draft.participants, actor)) {
      return { ok: false, error: kernelErrors.forbidden(action, { reason: 'unknown-actor' }) };
    }
    return undefined;
  }

  #requireHuman(action: string, actor: string): KernelResult<void> {
    if (this.#draft.participants[actor]?.type !== 'human') {
      return {
        ok: false,
        error: kernelErrors.forbidden(action, {
          actor_kind: this.#draft.participants[actor]?.type ?? 'unknown',
        }),
      };
    }
    return { ok: true, value: undefined };
  }

  #blockingHoldIds(): readonly string[] {
    return Object.values(this.#draft.holds)
      .filter((h) => alive(h) && h.status === 'active' && h.blocks_delivery)
      .map((h) => h.id);
  }

  #daysBetween(fromIso: string, toIso: string): number {
    // NaN propagates by design: every grace/purge comparison is written so
    // that NaN fails the threshold the same way an unelapsed window does.
    return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / MILLISECONDS_PER_DAY);
  }

  // -- intended direction ---------------------------------------------------

  /**
   * Direction records are the project's third time plane. Proposing is
   * open to every participant on a non-terminal project; resolution is
   * human-only, reason-carrying, and terminal. Direction events are not
   * State-material: they repeat the current state version.
   */
  proposeDirection(cmd: ProposeDirectionCommand): KernelResult<IntendedDirectionRow> {
    const actorGuard = this.#requireKnownActor('propose_direction', cmd.actor);
    if (actorGuard !== undefined) return actorGuard;
    if (this.#draft.project === null) {
      return {
        ok: false,
        error: kernelErrors.forbidden('propose_direction', { reason: 'no-project' }),
      };
    }
    const p = this.#draft.project;
    if (p.status === 'completed' || p.status === 'archived') {
      return { ok: false, error: kernelErrors.projectNotActive(p.status, 'propose_direction') };
    }
    if (typeof cmd.title !== 'string' || cmd.title.trim().length === 0) {
      return {
        ok: false,
        error: kernelErrors.forbidden('propose_direction', { reason: 'title-length' }),
      };
    }
    const invalid = invalidFields('propose_direction', [
      ['actor', uuidv7Schema, cmd.actor],
      ['at', instantSchema, cmd.at],
      ['direction_id', uuidv7Schema, cmd.direction_id],
      ['title', intendedDirectionSchema.shape.title, cmd.title],
      ['detail', intendedDirectionSchema.shape.detail, cmd.detail],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    if (this.#draft.intended_directions[cmd.direction_id] !== undefined) {
      return {
        ok: false,
        error: kernelErrors.forbidden('propose_direction', { reason: 'direction-exists' }),
      };
    }
    this.#append('direction.proposed', cmd.at, cmd.actor, {
      direction_id: cmd.direction_id,
      title: cmd.title.trim(),
      ...(cmd.detail === undefined ? {} : { detail: cmd.detail }),
    });
    return success(this.#draft.intended_directions[cmd.direction_id] as IntendedDirectionRow);
  }

  resolveDirection(cmd: ResolveDirectionCommand): KernelResult<IntendedDirectionRow> {
    // requireHuman doubles as the known-actor guard: only a registered
    // participant can carry type 'human', so agents and ghosts both fail it.
    const humanGuard = this.#requireHuman('resolve_direction', cmd.actor);
    if (!humanGuard.ok) return humanGuard;
    const invalid = invalidFields('resolve_direction', [
      ['actor', uuidv7Schema, cmd.actor],
      ['at', instantSchema, cmd.at],
      ['direction_id', uuidv7Schema, cmd.direction_id],
      ['resolution', z.enum(['confirmed', 'discarded']), cmd.resolution],
      ['resolution_reason', z.string().min(1).max(4096), cmd.resolution_reason],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const dir = this.#draft.intended_directions[cmd.direction_id];
    if (dir === undefined || dir.deleted_at !== undefined) {
      return {
        ok: false,
        error: kernelErrors.forbidden('resolve_direction', { reason: 'direction-not-found' }),
      };
    }
    if (dir.status !== 'proposed') {
      return {
        ok: false,
        error: kernelErrors.forbidden('resolve_direction', { reason: 'already-resolved' }),
      };
    }
    if (typeof cmd.resolution_reason !== 'string' || cmd.resolution_reason.trim().length === 0) {
      return { ok: false, error: kernelErrors.rationaleRequired('resolve_direction') };
    }
    if (this.stateVersion !== cmd.expected_version) {
      return {
        ok: false,
        error: kernelErrors.versionConflict(cmd.expected_version, this.stateVersion),
      };
    }
    this.#append('direction.resolved', cmd.at, cmd.actor, {
      direction_id: cmd.direction_id,
      resolution: cmd.resolution,
      resolution_reason: cmd.resolution_reason,
    });
    return success(this.#draft.intended_directions[cmd.direction_id] as IntendedDirectionRow);
  }

  // -- workrun execution ----------------------------------------------------

  #requireRun(
    runId: string,
    action: string,
  ): { readonly run: WorkRunRow } | { readonly ok: false; readonly error: KernelError } {
    const run = this.#draft.work_runs[runId];
    if (run === undefined || run.deleted_at !== undefined) {
      return {
        ok: false,
        error: kernelErrors.forbidden(action, { reason: 'run-not-found' }),
      };
    }
    return { run };
  }

  /** A changed boundary or released takeover requires current context; ledger order determines freshness. */
  #checkReEquipGate(
    action: 'transition_run',
    run: WorkRunRow,
    cmd: { readonly equip_id?: string; readonly actor: string },
  ): KernelResult<void> {
    if (run.re_equip_required !== true && run.input_state_version === this.stateVersion) {
      return { ok: true, value: undefined };
    }
    if (cmd.equip_id === undefined) {
      return { ok: false, error: kernelErrors.forbidden(action, { reason: 're-equip-required' }) };
    }
    const equip = this.#draft.equips[cmd.equip_id];
    if (
      equip?.status !== 'active' ||
      equip.state_version !== this.#draft.project?.current_state_version
    ) {
      return { ok: false, error: kernelErrors.forbidden(action, { reason: 'stale-equip' }) };
    }
    if (equip.participant_id !== cmd.actor) {
      return { ok: false, error: kernelErrors.forbidden(action, { reason: 'foreign-equip' }) };
    }
    if (equip.work_id !== undefined && equip.work_id !== run.work_id) {
      return { ok: false, error: kernelErrors.forbidden(action, { reason: 'foreign-work-equip' }) };
    }
    const history = this.#history.all();
    const release = history.findLast(
      (event) =>
        event.type === 'intervention.session_closed' &&
        event.data['run_id'] === run.id &&
        event.data['was_takeover'] === true,
    );
    if (
      release !== undefined &&
      !history.some(
        (event) =>
          event.type === 'equip.issued' &&
          event.data['equip_id'] === equip.id &&
          event.seq > release.seq,
      )
    ) {
      return { ok: false, error: kernelErrors.forbidden(action, { reason: 'stale-equip' }) };
    }
    return { ok: true, value: undefined };
  }

  startRun(cmd: StartRunCommand): KernelResult<WorkRunRow> {
    const actorGuard = this.#requireKnownActor('start_run', cmd.actor);
    if (actorGuard !== undefined) return actorGuard;
    const project = this.#draft.project;
    if (project?.status !== 'active') {
      return {
        ok: false,
        error: kernelErrors.projectNotActive(project?.status ?? 'archived', 'start_run'),
      };
    }
    if (cmd.expected_version !== project.current_state_version) {
      return {
        ok: false,
        error: kernelErrors.versionConflict(cmd.expected_version, project.current_state_version),
      };
    }
    // Guard first: closed works (tombstoned/completed/cancelled) — result must not
    // depend on order-of-evaluation with equip checks.
    const targetWork = this.#draft.works[cmd.work_id];
    if (
      targetWork === undefined ||
      !alive(targetWork) ||
      targetWork.status === 'cancelled' ||
      targetWork.status === 'completed'
    ) {
      return {
        ok: false,
        error: kernelErrors.forbidden('start_run', { reason: 'work-closed' }),
      };
    }
    if (this.#draft.work_runs[cmd.run_id] !== undefined) {
      return { ok: false, error: kernelErrors.forbidden('start_run', { reason: 'run-exists' }) };
    }
    const equip = this.#draft.equips[cmd.equip_id];
    if (equip?.status !== 'active' || equip.state_version !== project.current_state_version) {
      return { ok: false, error: kernelErrors.forbidden('start_run', { reason: 'stale-equip' }) };
    }
    if (equip.participant_id !== cmd.actor) {
      return { ok: false, error: kernelErrors.forbidden('start_run', { reason: 'foreign-equip' }) };
    }
    if (equip.work_id !== undefined && equip.work_id !== cmd.work_id) {
      return {
        ok: false,
        error: kernelErrors.forbidden('start_run', { reason: 'foreign-work-equip' }),
      };
    }
    const invalid = invalidFields('start_run', [
      ['actor', uuidv7Schema, cmd.actor],
      ['at', instantSchema, cmd.at],
      ['run_id', uuidv7Schema, cmd.run_id],
      ['work_id', uuidv7Schema, cmd.work_id],
      ['equip_id', uuidv7Schema, cmd.equip_id],
      ['parent_run_id', uuidv7Schema.optional(), cmd.parent_run_id],
      ['execution_refs', executionRefsSchema.optional(), cmd.execution_refs],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    let attempt = 1;
    if (cmd.parent_run_id !== undefined) {
      const parent = this.#draft.work_runs[cmd.parent_run_id];
      if (parent?.work_id !== cmd.work_id) {
        return {
          ok: false,
          error: kernelErrors.forbidden('start_run', { reason: 'parent-run-invalid' }),
        };
      }
      if (parent.status !== 'cancelled' && parent.status !== 'failed') {
        return {
          ok: false,
          error: kernelErrors.forbidden('start_run', { reason: 'parent-run-not-terminal' }),
        };
      }
      attempt = (parent.attempt ?? 1) + 1;
    }
    this.#append('workrun.started', cmd.at, cmd.actor, {
      run_id: cmd.run_id,
      work_id: cmd.work_id,
      ...(cmd.parent_run_id === undefined ? {} : { parent_run_id: cmd.parent_run_id }),
      attempt,
      ...(cmd.execution_refs === undefined ? {} : { execution_refs: cmd.execution_refs }),
    });
    return success(this.#draft.work_runs[cmd.run_id] as WorkRunRow);
  }

  transitionRun(cmd: TransitionRunCommand): KernelResult<WorkRunRow> {
    const actorGuard = this.#requireKnownActor('transition_run', cmd.actor);
    if (actorGuard !== undefined) return actorGuard;
    const fetched = this.#requireRun(cmd.run_id, 'transition_run');
    if ('ok' in fetched) return fetched;
    const run = fetched.run;
    const transition = assertWorkRunTransition(run.status, cmd.to);
    if (!transition.ok) return { ok: false, error: transition.error };
    if (run.run_revision !== cmd.run_revision) {
      return { ok: false, error: kernelErrors.versionConflict(cmd.run_revision, run.run_revision) };
    }
    if (this.stateVersion !== cmd.expected_version) {
      return {
        ok: false,
        error: kernelErrors.versionConflict(cmd.expected_version, this.stateVersion),
      };
    }
    if (typeof cmd.reason !== 'string' || cmd.reason.trim().length === 0) {
      return { ok: false, error: kernelErrors.rationaleRequired('transition_run') };
    }
    const resuming =
      (run.status === 'waiting_input' && cmd.to === 'running') ||
      (run.status === 'waiting_approval' && cmd.to === 'running') ||
      (run.status === 'paused' && cmd.to === 'running');
    if (resuming) {
      const gate = this.#checkReEquipGate('transition_run', run, cmd);
      if (!gate.ok) return gate;
    }
    if (
      run.status === 'waiting_input' &&
      cmd.to === 'running' &&
      cmd.input_provided === undefined
    ) {
      return {
        ok: false,
        error: kernelErrors.forbidden('transition_run', { reason: 'input-evidence-required' }),
      };
    }
    if (run.status === 'waiting_approval' && cmd.to === 'running') {
      if (cmd.approval_result === undefined) {
        return {
          ok: false,
          error: kernelErrors.forbidden('transition_run', { reason: 'approval-evidence-required' }),
        };
      }
      const humanGuard = this.#requireHuman('transition_run', cmd.actor);
      if (!humanGuard.ok) return humanGuard;
    }
    if (run.status === 'paused' && cmd.to === 'running') {
      // the reference must name this run's own last recorded checkpoint; any
      // other id (another run's, or an older one of this run) is a mismatch
      if (cmd.resume_checkpoint_id === undefined) {
        return {
          ok: false,
          error: kernelErrors.forbidden('transition_run', { reason: 'resume-checkpoint-required' }),
        };
      }
      if (cmd.resume_checkpoint_id !== run.checkpoint_id) {
        return {
          ok: false,
          error: kernelErrors.forbidden('transition_run', { reason: 'resume-checkpoint-mismatch' }),
        };
      }
    }
    const invalid = invalidFields('transition_run', [
      ['actor', uuidv7Schema, cmd.actor],
      ['at', instantSchema, cmd.at],
      ['run_id', uuidv7Schema, cmd.run_id],
      ['to', workRunStatusSchema, cmd.to],
      ['reason', textSchema, cmd.reason],
      ['equip_id', uuidv7Schema.optional(), cmd.equip_id],
      ['input_provided', textSchema.optional(), cmd.input_provided],
      ['approval_result', textSchema.optional(), cmd.approval_result],
      ['resume_checkpoint_id', uuidv7Schema.optional(), cmd.resume_checkpoint_id],
      ['checkpoint_reason', textSchema.optional(), cmd.checkpoint_reason],
      [
        'checkpoint_position',
        z.record(z.string().min(1).max(128), z.json()).optional(),
        cmd.checkpoint_position,
      ],
      [
        'checkpoint_resume_ref',
        z.record(z.string().min(1).max(128), z.string().max(2048)).optional(),
        cmd.checkpoint_resume_ref,
      ],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    const checkpointPayload: Record<string, unknown> | undefined =
      cmd.to === 'paused'
        ? {
            id: uuidv7(),
            run_id: cmd.run_id,
            ...(cmd.checkpoint_reason === undefined ? {} : { reason: cmd.checkpoint_reason }),
            ...(cmd.checkpoint_position === undefined ? {} : { position: cmd.checkpoint_position }),
            ...(cmd.checkpoint_resume_ref === undefined
              ? {}
              : { resume_ref: cmd.checkpoint_resume_ref }),
          }
        : undefined;

    const data: Record<string, unknown> = {
      run_id: cmd.run_id,
      from: run.status,
      to: cmd.to,
      reason: cmd.reason,
      run_revision: run.run_revision + 1,
      resume: resuming,
      ...(cmd.input_provided === undefined ? {} : { input_provided: cmd.input_provided }),
      ...(cmd.approval_result === undefined ? {} : { approval_result: cmd.approval_result }),
      ...(cmd.resume_checkpoint_id === undefined
        ? {}
        : { resume_checkpoint_id: cmd.resume_checkpoint_id }),
      ...(checkpointPayload === undefined ? {} : { checkpoint: checkpointPayload }),
    };
    this.#append('workrun.transitioned', cmd.at, cmd.actor, data);
    return success(this.#draft.work_runs[cmd.run_id] as WorkRunRow);
  }

  openIntervention(cmd: OpenInterventionCommand): KernelResult<WorkRunRow> {
    const fetched = this.#requireRun(cmd.run_id, 'open_intervention');
    if ('ok' in fetched) return fetched;
    const run = fetched.run;
    const actorGuard = this.#requireKnownActor('open_intervention', cmd.actor);
    if (actorGuard !== undefined) return actorGuard;
    const invalid = invalidFields('open_intervention', [
      ['actor', uuidv7Schema, cmd.actor],
      ['at', instantSchema, cmd.at],
      ['run_id', uuidv7Schema, cmd.run_id],
      ['session_id', z.string().min(1).max(128), cmd.session_id],
      ['mode', interventionModeSchema, cmd.mode],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    if (run.intervention_sessions.some((session) => session.session_id === cmd.session_id)) {
      return {
        ok: false,
        error: kernelErrors.forbidden('open_intervention', { reason: 'session-exists' }),
      };
    }
    if (run.run_revision !== cmd.run_revision) {
      return { ok: false, error: kernelErrors.versionConflict(cmd.run_revision, run.run_revision) };
    }
    if (this.#draft.project?.current_state_version !== cmd.expected_version) {
      return {
        ok: false,
        error: kernelErrors.versionConflict(
          cmd.expected_version,
          this.#draft.project?.current_state_version ?? 0,
        ),
      };
    }
    if (cmd.mode === 'takeover') {
      const opening = checkTakeoverOpening(run.intervention_sessions, cmd.actor);
      if (!opening.ok) {
        return {
          ok: false,
          error: kernelErrors.forbidden('open_intervention', { reason: opening.reason }),
        };
      }
    }
    const consent = initialConsent(cmd.mode);
    this.#append('intervention.session_opened', cmd.at, cmd.actor, {
      run_id: cmd.run_id,
      session_id: cmd.session_id,
      mode: cmd.mode,
      run_revision: run.run_revision + 1,
      ...(consent === undefined ? {} : { consent_status: consent }),
    });
    return success(this.#draft.work_runs[cmd.run_id] as WorkRunRow);
  }

  closeIntervention(cmd: CloseInterventionCommand): KernelResult<WorkRunRow> {
    const fetched = this.#requireRun(cmd.run_id, 'close_intervention');
    if ('ok' in fetched) return fetched;
    const run = fetched.run;
    const actorGuard = this.#requireKnownActor('close_intervention', cmd.actor);
    if (actorGuard !== undefined) return actorGuard;
    const invalid = invalidFields('close_intervention', [
      ['actor', uuidv7Schema, cmd.actor],
      ['at', instantSchema, cmd.at],
      ['run_id', uuidv7Schema, cmd.run_id],
      ['session_id', z.string().min(1).max(128), cmd.session_id],
      ['consent_status', z.enum(['granted', 'denied']).optional(), cmd.consent_status],
    ]);
    if (invalid !== undefined) return { ok: false, error: invalid };
    if (run.run_revision !== cmd.run_revision) {
      return { ok: false, error: kernelErrors.versionConflict(cmd.run_revision, run.run_revision) };
    }
    if (this.#draft.project?.current_state_version !== cmd.expected_version) {
      return {
        ok: false,
        error: kernelErrors.versionConflict(
          cmd.expected_version,
          this.#draft.project?.current_state_version ?? 0,
        ),
      };
    }
    const session = run.intervention_sessions.find((x) => x.session_id === cmd.session_id);
    if (session === undefined || session.ended_at !== undefined) {
      return {
        ok: false,
        error: kernelErrors.forbidden('close_intervention', { reason: 'session-not-found' }),
      };
    }
    const actorType = this.#draft.participants[cmd.actor]?.type;
    const authority = checkCloseAuthority(session, cmd.actor, actorType === 'human');
    if (!authority.ok) {
      return {
        ok: false,
        error: kernelErrors.forbidden('close_intervention', { reason: authority.reason }),
      };
    }
    const consent = checkTerminalConsent(session.mode, cmd.consent_status);
    if (!consent.ok) {
      return {
        ok: false,
        error: kernelErrors.forbidden('close_intervention', { reason: consent.reason }),
      };
    }
    this.#append('intervention.session_closed', cmd.at, cmd.actor, {
      run_id: cmd.run_id,
      session_id: cmd.session_id,
      was_takeover: session.mode === 'takeover',
      run_revision: run.run_revision + 1,
      ...(consent.consent === undefined ? {} : { consent_status: consent.consent }),
    });
    return success(this.#draft.work_runs[cmd.run_id] as WorkRunRow);
  }

  /**
   * The single append+apply path. Computes seq (head+1) and the
   * post-event state_version (State-material events bump it; everything
   * else repeats), stamps the envelope schema_version, freezes via the
   * history, and folds the event through the replay applier into the live
   * draft. There is NO update or delete path — the surface is append-only.
   */
  #append(
    type: KernelEventType,
    at: string,
    actor: string | null,
    data: Record<string, unknown>,
  ): StateEvent {
    // Every command caller passes `at` through invalidFields (instantSchema)
    // before reaching this point; the event-data schema here is the final
    // field-contract gate before the event becomes history.
    parseEventData(type, data);
    // advance the actor's clock component; the null-actor registration event
    // advances nobody (its subject joins from its own next action)
    const frozen = this.#history.append({
      seq: this.#history.currentSeq + 1,
      type,
      data,
      actor,
      at,
      state_version: STATE_MATERIAL_EVENTS.has(type) ? this.stateVersion + 1 : this.stateVersion,
      schema_version: STATE_EVENT_SCHEMA_VERSION,
    });
    applyEvent(this.#draft, frozen);
    if (actor !== null) this.#causalClock = advanceClock(this.#causalClock, actor);
    this.#projectionView = undefined;
    return frozen;
  }
}
