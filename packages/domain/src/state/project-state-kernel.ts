import { canonicalEquals, deepFreeze } from './canonical.js';
import { EventHistory } from './event-history.js';
import type { StateEvent } from './events.js';
import { kernelErrors, type KernelError } from '../errors/kernel.js';
import { assertTransition } from '../schema/asset.js';
import { uuidv7 } from '../schema/ids.js';
import type { SchemaError } from '../errors/schema.js';
import type { AssetLifecycle } from '../schema/asset.js';
import type { HoldStatus } from '../schema/hold.js';

/**
 * Project state kernel — the trust engine over one project aggregate.
 * It owns: the append-only event history, the replay-built projection,
 * optimistic concurrency, the human-only
 * boundary/status gates, the hold confirmation chain, the equip/return
 * contract, the effect ledger, and the per-asset delivery gate.
 *
 * The kernel never reads a clock: every command carries the caller's
 * logical `at`. All rejections return Result objects whose errors carry
 * registry tokens from `errors/kernel.ts` — no bare string literals.
 */

/**
 * Tuning constants — named, with provenance; kernel logic never compares
 * against numeric literals for these values (spec: constants are named,
 * not magic). A constant lives in the file of the capability it tunes.
 *
 * EQUIP_SIZE_BUDGET: serialized byte budget for one equip's verified_facts
 *   fact set. A global constant, not per-project config.
 * COMPETITIVE_GRACE_PERIOD_DAYS: how long a competitively superseded asset
 *   may roll back to active (the grace-period rollback edge of the
 *   lifecycle table). Accepted at 90 days.
 * STATE_EVENT_SCHEMA_VERSION: the envelope schema_version the kernel
 *   stamps on every appended event.
 */
export const EQUIP_SIZE_BUDGET = 64 * 1024; // serialized UTF-8 bytes
export const COMPETITIVE_GRACE_PERIOD_DAYS = 90; // accepted value
export const STATE_EVENT_SCHEMA_VERSION = 1;

/** The closed event vocabulary the kernel emits (namespaced kebab-case). */
export const KERNEL_EVENT_TYPES = [
  'participant.registered',
  'project.created',
  'project.boundary_updated',
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
  'effect.recorded',
  'effect.closed',
  'delivery.recorded',
  'delivery.confirmed',
] as const;

export type KernelEventType = (typeof KERNEL_EVENT_TYPES)[number];

/** The hold-status-carrying subset of the kernel event vocabulary. */
type HoldEventType = Extract<KernelEventType, `hold.${string}`>;

/**
 * State-material events — the ONLY events that advance
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

/** Hold event type per target status — the event vocabulary IS the transition. */
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

// ---------------------------------------------------------------------------
// Projection row shapes (plain JSON-safe records — replay must reproduce
// them exactly via canonical JSON).
// ---------------------------------------------------------------------------

export interface ParticipantRow {
  readonly id: string;
  readonly type: 'human' | 'agent';
  readonly display_name?: string;
  readonly deleted_at?: string;
}

export interface ProjectRow {
  readonly id: string;
  readonly title: string;
  readonly purpose?: string;
  readonly boundary?: string;
  readonly acceptance_criteria?: readonly string[];
  readonly status: 'active' | 'paused' | 'completed' | 'archived';
  readonly current_state_version: number;
  readonly created_at: string;
  /** Replay-written project time; commands never set these two fields. */
  readonly updated_at?: string;
  readonly updated_by?: string | null;
  readonly deleted_at?: string;
}

export interface WorkRow {
  readonly id: string;
  readonly title: string;
  readonly status: 'planned' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
  readonly direction?: string;
  readonly aggregate_revision: number;
  readonly created_at: string;
  readonly updated_at?: string;
  readonly updated_by?: string | null;
  readonly deleted_at?: string;
}

export interface AssetRow {
  readonly id: string;
  readonly kind: string;
  readonly scope: string;
  readonly project_id?: string;
  readonly lifecycle: string;
  readonly provenance?: string;
  readonly content?: { readonly storage: string; readonly sha256?: string } & Record<
    string,
    unknown
  >;
  readonly created_at: string;
  readonly archived_at?: string;
  readonly competitive_superseded_at?: string;
  readonly updated_at?: string;
  readonly updated_by?: string | null;
  readonly deleted_at?: string;
}

export interface HoldRow {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly status: HoldStatus;
  readonly blocks_delivery: boolean;
  readonly statement: string;
  readonly asset_refs?: readonly string[];
  readonly registered_by: string;
  readonly created_at: string;
  readonly updated_at?: string;
  readonly updated_by?: string | null;
  readonly deleted_at?: string;
}

export interface AcceptanceRow {
  readonly id: string;
  readonly asset_id: string;
  readonly result: string;
  readonly rationale?: string;
  readonly criteria_snapshot: Readonly<Record<string, unknown>>;
  readonly actor: string;
  readonly created_at: string;
  readonly deleted_at?: string;
}

export interface CheckpointRow {
  readonly id: string;
  readonly work_id: string;
  readonly reason?: string;
  readonly captured_at: string;
  readonly state_version: number;
  readonly position?: Readonly<Record<string, unknown>>;
  readonly deleted_at?: string;
}

export interface DeliveryRow {
  readonly id: string;
  readonly asset_id: string;
  readonly target_ref: string;
  readonly target_type: string;
  readonly dispatched_at: string;
  readonly version: string;
  readonly attempt_no: number;
  readonly delivered_by: string;
  readonly confirmation_status: 'delivered' | 'confirmed' | 'rejected' | 'pending';
  readonly confirmed_by?: string;
  readonly confirmed_at?: string;
  readonly created_at: string;
  readonly updated_at?: string;
  readonly updated_by?: string | null;
  readonly deleted_at?: string;
}

export interface EffectRow {
  readonly id: string;
  readonly asset_ref?: string;
  readonly description?: string;
  readonly status: 'unknown' | 'confirmed' | 'failed';
  readonly created_at: string;
  readonly closed_at?: string;
  readonly updated_at?: string;
  readonly updated_by?: string | null;
  readonly deleted_at?: string;
}

/**
 * Issuance registry row for one equip — identity, version binding, and
 * staleness only. The equip's fact payload is derived at request time and
 * never stored as business data (spec: the Equip is a derived projection).
 */
export interface EquipRow {
  readonly id: string;
  readonly work_id?: string;
  readonly participant_id?: string;
  readonly state_version: number;
  readonly status: 'active' | 'stale';
}

export interface KernelProjection {
  readonly project: ProjectRow | null;
  readonly participants: Readonly<Record<string, ParticipantRow>>;
  readonly works: Readonly<Record<string, WorkRow>>;
  readonly assets: Readonly<Record<string, AssetRow>>;
  readonly holds: Readonly<Record<string, HoldRow>>;
  readonly acceptances: Readonly<Record<string, AcceptanceRow>>;
  readonly checkpoints: Readonly<Record<string, CheckpointRow>>;
  readonly deliveries: Readonly<Record<string, DeliveryRow>>;
  readonly effects: Readonly<Record<string, EffectRow>>;
  readonly equips: Readonly<Record<string, EquipRow>>;
}

/** The derived equip handed to the caller at issuance — never persisted as business data. */
export interface IssuedEquip {
  readonly id: string;
  readonly work_id?: string;
  readonly participant_id?: string;
  readonly state_version: number;
  readonly verified_facts: readonly string[];
  readonly active_assets: readonly string[];
  readonly active_holds: readonly string[];
  readonly boundary?: string;
  readonly acceptance_criteria?: readonly string[];
  readonly allowed_actions?: readonly string[];
  readonly issued_at: string;
  readonly status: 'active';
}

export type KernelResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KernelError | SchemaError };

// ---------------------------------------------------------------------------
// Mutable draft mirrors (applyEvent mutates these; the public projection is
// the readonly view).
// ---------------------------------------------------------------------------

type Draft<T> = { -readonly [K in keyof T]: T[K] };
interface MutableProjection {
  project: Draft<ProjectRow> | null;
  participants: Record<string, Draft<ParticipantRow>>;
  works: Record<string, Draft<WorkRow>>;
  assets: Record<string, Draft<AssetRow>>;
  holds: Record<string, Draft<HoldRow>>;
  acceptances: Record<string, Draft<AcceptanceRow>>;
  checkpoints: Record<string, Draft<CheckpointRow>>;
  deliveries: Record<string, Draft<DeliveryRow>>;
  effects: Record<string, Draft<EffectRow>>;
  equips: Record<string, Draft<EquipRow>>;
}

const emptyProjection = (): MutableProjection => ({
  project: null,
  participants: {},
  works: {},
  assets: {},
  holds: {},
  acceptances: {},
  checkpoints: {},
  deliveries: {},
  effects: {},
  equips: {},
});

/** Tombstone read-side: every lookup and gate evaluation excludes deleted rows. */
const alive = (row: { readonly deleted_at?: string }): boolean => row.deleted_at === undefined;

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
        type: data['type'] as 'human' | 'agent',
        ...(data['display_name'] === undefined
          ? {}
          : { display_name: data['display_name'] as string }),
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
        title: data['title'] as string,
        status: 'planned',
        ...(data['direction'] === undefined ? {} : { direction: data['direction'] as string }),
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
        kind: seed['kind'] as string,
        scope: seed['scope'] as string,
        ...(seed['project_id'] === undefined ? {} : { project_id: seed['project_id'] as string }),
        lifecycle: 'candidate',
        ...(seed['provenance'] === undefined ? {} : { provenance: seed['provenance'] as string }),
        ...(seed['content'] === undefined
          ? {}
          : { content: seed['content'] as NonNullable<AssetRow['content']> }),
        created_at: e.at,
      };
      break;
    }
    case 'asset.lifecycle_changed': {
      const a = must(d.assets[data['asset_id'] as string], 'asset');
      a.lifecycle = data['to'] as string;
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
        result: data['result'] as string,
        ...(data['rationale'] === undefined ? {} : { rationale: data['rationale'] as string }),
        criteria_snapshot: data['criteria_snapshot'] as Record<string, unknown>,
        actor: data['actor'] as string,
        created_at: e.at,
      };
      break;
    }
    case 'hold.registered': {
      d.holds[data['hold_id'] as string] = {
        id: data['hold_id'] as string,
        kind: data['kind'] as string,
        severity: data['severity'] as string,
        status: data['initial_status'] as HoldStatus,
        blocks_delivery: data['blocks_delivery'] as boolean,
        statement: data['statement'] as string,
        ...(data['asset_refs'] === undefined
          ? {}
          : { asset_refs: data['asset_refs'] as readonly string[] }),
        registered_by: data['registered_by'] as string,
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
        status: 'active',
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
    case 'return.absorbed': {
      const candidates = data['candidates'] as readonly Record<string, unknown>[];
      for (const seed of candidates) {
        d.assets[seed['id'] as string] = {
          id: seed['id'] as string,
          kind: seed['kind'] as string,
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
        target_type: data['target_type'] as string,
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
      break;
    }
    default:
      throw new Error(`invalid event: unknown event type ${e.type}`);
  }
  // Version sync + project time — replay path only (see function doc).
  if (d.project !== null) {
    if (STATE_MATERIAL_EVENTS.has(e.type)) {
      d.project.current_state_version = e.state_version;
    }
    d.project.updated_at = e.at;
    d.project.updated_by = e.actor ?? null;
  }
  // Per-row replay time for the touched aggregate row.
  const touch = (
    row: Draft<{ updated_at?: string; updated_by?: string | null }> | undefined,
  ): void => {
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
    case 'participant.registered':
    case 'project.created':
    case 'project.boundary_updated':
    case 'project.status_changed':
    case 'acceptance.recorded':
    case 'checkpoint.created':
    case 'equip.issued':
    case 'equip.budget_exceeded':
    case 'return.absorbed':
    case 'return.rejected':
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
  readonly kind: string;
  readonly scope: string;
  readonly project_id?: string;
  readonly provenance?: string;
  readonly content?: { readonly storage: string; readonly sha256?: string } & Record<
    string,
    unknown
  >;
  readonly expected_version: number;
}

export interface TransitionAssetCommand {
  readonly actor: string;
  readonly at: string;
  readonly asset_id: string;
  readonly to: AssetLifecycle | 'purged';
  readonly reason?: string;
  readonly double_confirmation?: boolean;
  readonly expected_version: number;
}

export type AcceptanceResult = 'accepted' | 'rejected' | 'conditional';

export interface AcceptAssetCommand {
  readonly actor: string;
  readonly at: string;
  readonly asset_id: string;
  readonly result: AcceptanceResult;
  readonly rationale?: string;
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
  readonly kind: string;
  readonly provenance?: string;
  readonly content?: { readonly storage: string; readonly sha256?: string } & Record<
    string,
    unknown
  >;
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
  private readonly history = new EventHistory();
  private readonly draft: MutableProjection = emptyProjection();

  /** Read-only view of the live replay-built projection. */
  get projection(): KernelProjection {
    return this.draft;
  }

  get stateVersion(): number {
    return this.draft.project?.current_state_version ?? 0;
  }

  get currentSeq(): number {
    return this.history.currentSeq;
  }

  /** Read-only view of the full history (spec: append-only surface). */
  get events(): readonly StateEvent[] {
    return this.history.all();
  }

  /** Tamper probe: history integrity AND live-vs-rebuilt canonical identity. */
  verifyIntegrity(): { ok: true } | { ok: false; atSeq?: number; reason: string } {
    const probe = this.history.verifyIntegrity();
    if (!probe.ok) return probe;
    const rebuilt = deepFreeze(this.rebuildProjection());
    if (!canonicalEquals(this.draft, rebuilt)) {
      return { ok: false, reason: 'live projection diverges from replay' };
    }
    return { ok: true };
  }

  /** Full replay into a fresh projection (canonical-JSON equal to the live one). */
  rebuildProjection(): KernelProjection {
    const d = emptyProjection();
    for (const e of this.history.all()) applyEvent(d, e);
    return d;
  }

  /**
   * Rebuilds a kernel from a persisted event log (the storage replay
   * path). Each event is re-validated and re-frozen through the same
   * history applier, so a rebuilt kernel is canonical-JSON identical to
   * the live one when the log is intact.
   */
  static fromEvents(events: readonly StateEvent[]): ProjectStateKernel {
    const k = new ProjectStateKernel();
    for (const e of events) {
      const frozen = k.history.append(e);
      applyEvent(k.draft, frozen);
    }
    return k;
  }

  // -- commands ------------------------------------------------------------

  /** Typed read of the singleton project row; throws on the impossible empty state. */
  private requireProject(): ProjectRow {
    return must(this.draft.project, 'project');
  }

  registerParticipant(cmd: RegisterParticipantCommand): KernelResult<ParticipantRow> {
    const existing = this.draft.participants[cmd.participant_id];
    if (existing !== undefined) {
      return {
        ok: false,
        error: kernelErrors.forbidden('register_participant', { reason: 'participant-exists' }),
      };
    }
    this.append('participant.registered', cmd.at, null, {
      participant_id: cmd.participant_id,
      type: cmd.type,
      ...(cmd.display_name === undefined ? {} : { display_name: cmd.display_name }),
    });
    return { ok: true, value: this.draft.participants[cmd.participant_id] as ParticipantRow };
  }

  createProject(cmd: CreateProjectCommand): KernelResult<ProjectRow> {
    if (this.draft.project !== null || cmd.expected_version !== 0) {
      return {
        ok: false,
        error: kernelErrors.versionConflict(cmd.expected_version, this.stateVersion),
      };
    }
    const projectId = uuidv7();
    this.append('project.created', cmd.at, cmd.actor, {
      project_id: projectId,
      title: cmd.title,
      ...(cmd.purpose === undefined ? {} : { purpose: cmd.purpose }),
      ...(cmd.boundary === undefined ? {} : { boundary: cmd.boundary }),
      ...(cmd.acceptance_criteria === undefined
        ? {}
        : { acceptance_criteria: [...cmd.acceptance_criteria] }),
    });
    return { ok: true, value: this.requireProject() };
  }

  /**
   * Boundary update — human-only, reason-gated, State-material. Updates
   * the Project's direction fields and marks every equip bound to an
   * older version stale (full invalidation).
   */
  updateBoundary(cmd: UpdateBoundaryCommand): KernelResult<ProjectRow> {
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'update_boundary',
      cmd.actor,
      cmd.reason,
      true,
    );
    if (!gate.ok) return gate;
    if (cmd.boundary === undefined && cmd.acceptance_criteria === undefined) {
      return { ok: false, error: kernelErrors.forbidden('update_boundary', { reason: 'no-op' }) };
    }
    this.append('project.boundary_updated', cmd.at, cmd.actor, {
      actor: cmd.actor,
      reason: cmd.reason,
      ...(cmd.boundary === undefined ? {} : { boundary: cmd.boundary }),
      ...(cmd.acceptance_criteria === undefined
        ? {}
        : { acceptance_criteria: [...cmd.acceptance_criteria] }),
    });
    return { ok: true, value: this.draft.project as ProjectRow };
  }

  /**
   * Project status transition — human-only, reason-carrying,
   * non-destructive. Pause from active; resume from paused; complete from
   * active (refused while a blocking hold is active); archive from any
   * live status (cancels incomplete works and invalidates non-resolved
   * holds, each closure event carrying the archive cause).
   */
  setProjectStatus(cmd: SetProjectStatusCommand): KernelResult<ProjectRow> {
    const humanGate = this.requireHuman('set_project_status', cmd.actor);
    if (!humanGate.ok) return humanGate;
    if (cmd.reason.trim().length === 0) {
      return { ok: false, error: kernelErrors.rationaleRequired('set_project_status') };
    }
    const p = this.draft.project;
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
      const blocking = this.blockingHoldIds();
      if (blocking.length > 0) {
        return { ok: false, error: kernelErrors.blockingHold(blocking) };
      }
    }
    if (cmd.to === 'archived') {
      // Closure cascade FIRST, each closure event carrying the cause; the
      // status change lands last and is the State-material version bump.
      const cause = `project archive: ${cmd.reason}`;
      for (const w of Object.values(this.draft.works)) {
        if (!alive(w) || w.status === 'completed' || w.status === 'cancelled') continue;
        this.append('work.status_changed', cmd.at, cmd.actor, {
          work_id: w.id,
          from: w.status,
          to: 'cancelled',
          reason: cause,
          cause: 'project_archived',
          actor: cmd.actor,
        });
      }
      for (const h of Object.values(this.draft.holds)) {
        if (!alive(h) || (h.status !== 'registered' && h.status !== 'active')) continue;
        this.append(HOLD_EVENT_TYPE.invalidated, cmd.at, cmd.actor, {
          hold_id: h.id,
          from: h.status,
          to: 'invalidated',
          actor: cmd.actor,
          reason: cause,
          cause: 'project_archived',
        });
      }
    }
    this.append('project.status_changed', cmd.at, cmd.actor, {
      actor: cmd.actor,
      from,
      to: cmd.to,
      reason: cmd.reason,
    });
    return { ok: true, value: this.draft.project as ProjectRow };
  }

  createWork(cmd: CreateWorkCommand): KernelResult<WorkRow> {
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'create_work',
      cmd.actor,
      cmd.reason,
      true,
    );
    if (!gate.ok) return gate;
    const workId = uuidv7();
    this.append('work.created', cmd.at, cmd.actor, {
      work_id: workId,
      title: cmd.title,
      reason: cmd.reason,
      ...(cmd.direction === undefined ? {} : { direction: cmd.direction }),
      actor: cmd.actor,
    });
    return { ok: true, value: this.draft.works[workId] as WorkRow };
  }

  cancelWork(cmd: CancelWorkCommand): KernelResult<WorkRow> {
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'cancel_work',
      cmd.actor,
      cmd.reason,
      true,
    );
    if (!gate.ok) return gate;
    const w = this.draft.works[cmd.work_id];
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
    this.append('work.status_changed', cmd.at, cmd.actor, {
      work_id: cmd.work_id,
      from: w.status,
      to: 'cancelled',
      reason: cmd.reason,
      actor: cmd.actor,
    });
    return { ok: true, value: this.draft.works[cmd.work_id] as WorkRow };
  }

  /**
   * Work redirection — human-gated, reason-carrying; updates only
   * Work.direction and creates a Checkpoint (default on). A method
   * correction is NOT a boundary change: seq and the Work aggregate
   * revision advance while project_state_version stays unchanged.
   */
  redirectWork(cmd: RedirectWorkCommand): KernelResult<WorkRow> {
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'redirect_work',
      cmd.actor,
      cmd.reason,
      true,
    );
    if (!gate.ok) return gate;
    const w = this.draft.works[cmd.work_id];
    if (w === undefined || !alive(w)) {
      return {
        ok: false,
        error: kernelErrors.forbidden('redirect_work', { reason: 'work-not-found' }),
      };
    }
    const withCheckpoint = cmd.create_checkpoint ?? true;
    this.append('work.redirected', cmd.at, cmd.actor, {
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
    return { ok: true, value: this.draft.works[cmd.work_id] as WorkRow };
  }

  /** Candidate asset creation — the artifact enters as a proposal, never active. */
  createAsset(cmd: CreateAssetCommand): KernelResult<AssetRow> {
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'create_asset',
      cmd.actor,
      undefined,
      false,
    );
    if (!gate.ok) return gate;
    const assetId = uuidv7();
    this.append('asset.created', cmd.at, cmd.actor, {
      asset: {
        id: assetId,
        kind: cmd.kind,
        scope: cmd.scope,
        ...(cmd.project_id === undefined ? {} : { project_id: cmd.project_id }),
        ...(cmd.provenance === undefined ? {} : { provenance: cmd.provenance }),
        ...(cmd.content === undefined ? {} : { content: cmd.content }),
      },
      actor: cmd.actor,
    });
    return { ok: true, value: this.draft.assets[assetId] as AssetRow };
  }

  /**
   * Lifecycle transition through the schema machine's legal-pair table.
   * competitive_superseded→active additionally honors the grace window;
   * archived→purged requires the double condition
   * and lands as a retirement tombstone.
   */
  transitionAsset(cmd: TransitionAssetCommand): KernelResult<AssetRow> {
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'transition_asset',
      cmd.actor,
      undefined,
      false,
    );
    if (!gate.ok) return gate;
    const a = this.draft.assets[cmd.asset_id];
    if (a === undefined || !alive(a)) {
      return {
        ok: false,
        error: kernelErrors.forbidden('transition_asset', { reason: 'asset-not-found' }),
      };
    }
    if (cmd.to === 'active' && a.lifecycle === 'competitive_superseded') {
      // Invariant: applyEvent stamps competitive_superseded_at on supersede and
      // clears it on every other lifecycle, so a superseded row always has one.
      const days = this.daysBetween(must(a.competitive_superseded_at, 'superseded-at'), cmd.at);
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
            daysArchived: a.archived_at === undefined ? 0 : this.daysBetween(a.archived_at, cmd.at),
            doubleConfirmation: cmd.double_confirmation ?? false,
          }
        : undefined;
    const verdict = assertTransition(
      a.lifecycle as AssetLifecycle,
      cmd.to as AssetLifecycle,
      purgeGate,
    );
    if (!verdict.ok) return { ok: false, error: verdict.error };
    if (cmd.to === 'purged') {
      this.append('asset.purged', cmd.at, cmd.actor, {
        asset_id: cmd.asset_id,
        from: a.lifecycle,
        to: 'purged',
        reason: cmd.reason,
        actor: cmd.actor,
      });
    } else {
      this.append('asset.lifecycle_changed', cmd.at, cmd.actor, {
        asset_id: cmd.asset_id,
        from: a.lifecycle,
        to: cmd.to,
        reason: cmd.reason,
        actor: cmd.actor,
      });
    }
    return { ok: true, value: this.draft.assets[cmd.asset_id] as AssetRow };
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
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'accept_asset',
      cmd.actor,
      undefined,
      true,
    );
    if (!gate.ok) return gate;
    const a = this.draft.assets[cmd.asset_id];
    if (a === undefined || !alive(a)) {
      return {
        ok: false,
        error: kernelErrors.forbidden('accept_asset', { reason: 'asset-not-found' }),
      };
    }
    if ((cmd.result === 'rejected' || cmd.result === 'conditional') && !cmd.rationale) {
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
    const acceptanceId = uuidv7();
    this.append('acceptance.recorded', cmd.at, cmd.actor, {
      acceptance_id: acceptanceId,
      asset_id: cmd.asset_id,
      result: cmd.result,
      actor: cmd.actor,
      ...(cmd.rationale === undefined ? {} : { rationale: cmd.rationale }),
      criteria_snapshot: cmd.criteria_snapshot,
      ...(cmd.evidence_refs === undefined ? {} : { evidence_refs: [...cmd.evidence_refs] }),
    });
    if (cmd.result === 'accepted') {
      this.append('asset.lifecycle_changed', cmd.at, cmd.actor, {
        asset_id: cmd.asset_id,
        from: 'candidate',
        to: 'active',
        reason: 'accepted',
        actor: cmd.actor,
      });
    } else if (cmd.result === 'rejected') {
      this.append('asset.lifecycle_changed', cmd.at, cmd.actor, {
        asset_id: cmd.asset_id,
        from: 'candidate',
        to: 'rejected',
        reason: cmd.rationale,
        actor: cmd.actor,
      });
    }
    return {
      ok: true,
      value: { asset: this.draft.assets[cmd.asset_id] as AssetRow, acceptance_id: acceptanceId },
    };
  }

  /**
   * Hold registration — ai-proposes-human-enacts. An agent-registered hold
   * starts `registered` and blocks nothing; a human-registered hold is
   * `active` immediately. Every hold event's data carries the acting
   * Participant id.
   */
  registerHold(cmd: RegisterHoldCommand): KernelResult<HoldRow> {
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'register_hold',
      cmd.actor,
      undefined,
      false,
    );
    if (!gate.ok) return gate;
    if (cmd.statement.trim().length === 0) {
      return { ok: false, error: kernelErrors.rationaleRequired('register_hold') };
    }
    const initialStatus: HoldStatus =
      this.draft.participants[cmd.actor]?.type === 'human' ? 'active' : 'registered';
    const holdId = uuidv7();
    this.append('hold.registered', cmd.at, cmd.actor, {
      hold_id: holdId,
      kind: cmd.kind,
      severity: cmd.severity,
      initial_status: initialStatus,
      blocks_delivery: cmd.blocks_delivery ?? false,
      statement: cmd.statement,
      registered_by: cmd.actor,
      actor: cmd.actor,
      ...(cmd.asset_refs === undefined ? {} : { asset_refs: [...cmd.asset_refs] }),
    });
    return { ok: true, value: this.draft.holds[holdId] as HoldRow };
  }

  /** Hold lifecycle transition through the baseline table (confirm/close/reactivate). */
  transitionHold(cmd: TransitionHoldCommand): KernelResult<HoldRow> {
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'transition_hold',
      cmd.actor,
      undefined,
      false,
    );
    if (!gate.ok) return gate;
    const h = this.draft.holds[cmd.hold_id];
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
      const humanGate = this.requireHuman('transition_hold', cmd.actor);
      if (!humanGate.ok) return humanGate;
    }
    if (rule.reasonRequired && (cmd.reason === undefined || cmd.reason.trim().length === 0)) {
      return { ok: false, error: kernelErrors.rationaleRequired('transition_hold') };
    }
    this.append(HOLD_EVENT_TYPE[cmd.to], cmd.at, cmd.actor, {
      hold_id: cmd.hold_id,
      from: h.status,
      to: cmd.to,
      actor: cmd.actor,
      ...(cmd.reason === undefined ? {} : { reason: cmd.reason }),
    });
    return { ok: true, value: this.draft.holds[cmd.hold_id] as HoldRow };
  }

  /** Effect ledger entry — starts `unknown` (an unclosed unknown blocks delivery). */
  recordEffect(cmd: RecordEffectCommand): KernelResult<EffectRow> {
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'record_effect',
      cmd.actor,
      undefined,
      false,
    );
    if (!gate.ok) return gate;
    const effectId = uuidv7();
    this.append('effect.recorded', cmd.at, cmd.actor, {
      effect_id: effectId,
      actor: cmd.actor,
      ...(cmd.asset_ref === undefined ? {} : { asset_ref: cmd.asset_ref }),
      ...(cmd.description === undefined ? {} : { description: cmd.description }),
    });
    return { ok: true, value: this.draft.effects[effectId] as EffectRow };
  }

  /**
   * Close an effect: unknown→confirmed (it happened) or unknown→failed
   * (it did not). Closure is not success — the ledger equals reality
   * either way; both close states unblock delivery.
   */
  closeEffect(cmd: CloseEffectCommand): KernelResult<EffectRow> {
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'close_effect',
      cmd.actor,
      undefined,
      false,
    );
    if (!gate.ok) return gate;
    const ef = this.draft.effects[cmd.effect_id];
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
    this.append('effect.closed', cmd.at, cmd.actor, {
      effect_id: cmd.effect_id,
      outcome: cmd.outcome,
      actor: cmd.actor,
      ...(cmd.reason === undefined ? {} : { reason: cmd.reason }),
    });
    return { ok: true, value: this.draft.effects[cmd.effect_id] as EffectRow };
  }

  /**
   * Equip issuance — a derived contract, never stored as business data.
   * The ledger records the issuance fact (identity + version binding) so
   * staleness and wholesale return rejection are replayable; the fact
   * payload below is assembled at request time. Exceeding the serialized
   * fact budget fails explicitly with a diagnostics event.
   */
  issueEquip(cmd: IssueEquipCommand): KernelResult<IssuedEquip> {
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'issue_equip',
      cmd.actor,
      undefined,
      false,
    );
    if (!gate.ok) return gate;
    const version = this.stateVersion;
    const verifiedFacts = Object.values(this.draft.assets)
      .filter((a) => alive(a) && a.scope === 'project' && a.lifecycle === 'active')
      .map((a) => a.id);
    const serialized = new TextEncoder().encode(JSON.stringify(verifiedFacts)).length;
    if (serialized > EQUIP_SIZE_BUDGET) {
      this.append('equip.budget_exceeded', cmd.at, cmd.actor, {
        work_id: cmd.work_id,
        participant_id: cmd.participant_id,
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
    this.append('equip.issued', cmd.at, cmd.actor, {
      equip_id: equipId,
      state_version: version,
      actor: cmd.actor,
      ...(cmd.work_id === undefined ? {} : { work_id: cmd.work_id }),
      ...(cmd.participant_id === undefined ? {} : { participant_id: cmd.participant_id }),
      ...(cmd.allowed_actions === undefined ? {} : { allowed_actions: [...cmd.allowed_actions] }),
    });
    const p = this.draft.project as ProjectRow;
    return {
      ok: true,
      value: {
        id: equipId,
        ...(cmd.work_id === undefined ? {} : { work_id: cmd.work_id }),
        ...(cmd.participant_id === undefined ? {} : { participant_id: cmd.participant_id }),
        state_version: version,
        verified_facts: verifiedFacts,
        active_assets: Object.values(this.draft.assets)
          .filter(
            (a) =>
              alive(a) &&
              a.scope === 'project' &&
              (a.lifecycle === 'active' || a.lifecycle === 'candidate'),
          )
          .map((a) => a.id),
        active_holds: Object.values(this.draft.holds)
          .filter((h) => alive(h) && h.status === 'active')
          .map((h) => h.id),
        ...(p.boundary === undefined ? {} : { boundary: p.boundary }),
        ...(p.acceptance_criteria === undefined
          ? {}
          : { acceptance_criteria: p.acceptance_criteria }),
        ...(cmd.allowed_actions === undefined ? {} : { allowed_actions: cmd.allowed_actions }),
        issued_at: cmd.at,
        status: 'active',
      },
    };
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
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'submit_return',
      cmd.actor,
      undefined,
      false,
    );
    if (!gate.ok) return gate;
    const equip = this.draft.equips[cmd.equip_id];
    const current = this.stateVersion;
    if (equip?.status !== 'active' || equip.state_version !== current) {
      this.append('return.rejected', cmd.at, cmd.actor, {
        equip_id: cmd.equip_id,
        actor: cmd.actor,
        equip_state_version: equip === undefined ? null : equip.state_version,
        equip_status: equip === undefined ? 'unknown-equip' : equip.status,
        current_state_version: current,
        candidate_count: cmd.candidates?.length ?? 0,
        effect_count: cmd.effects?.length ?? 0,
      });
      return {
        ok: false,
        error: kernelErrors.versionConflict(equip?.state_version ?? current, current),
      };
    }
    const candidates = (cmd.candidates ?? []).map((seed) => ({
      id: uuidv7(),
      kind: seed.kind,
      ...(seed.provenance === undefined ? {} : { provenance: seed.provenance }),
      ...(seed.content === undefined ? {} : { content: seed.content }),
    }));
    const effects = (cmd.effects ?? []).map((seed) => ({
      id: uuidv7(),
      ...(seed.asset_ref === undefined ? {} : { asset_ref: seed.asset_ref }),
      ...(seed.description === undefined ? {} : { description: seed.description }),
    }));
    this.append('return.absorbed', cmd.at, cmd.actor, {
      equip_id: cmd.equip_id,
      actor: cmd.actor,
      candidates,
      effects,
    });
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
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'deliver',
      cmd.actor,
      undefined,
      false,
    );
    if (!gate.ok) return gate;
    const a = this.draft.assets[cmd.asset_id];
    if (a === undefined || !alive(a) || a.lifecycle !== 'active') {
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
    const blocking = Object.values(this.draft.holds).filter(
      (h) =>
        alive(h) &&
        h.status === 'active' &&
        h.blocks_delivery &&
        (h.asset_refs ?? []).includes(cmd.asset_id),
    );
    if (blocking.length > 0) {
      return { ok: false, error: kernelErrors.blockingHold(blocking.map((h) => h.id)) };
    }
    const unknownEffects = Object.values(this.draft.effects).filter(
      (ef) => alive(ef) && ef.status === 'unknown' && ef.asset_ref === cmd.asset_id,
    );
    if (unknownEffects.length > 0) {
      return {
        ok: false,
        error: kernelErrors.unknownEffectUnclosed(unknownEffects.map((ef) => ef.id)),
      };
    }
    const prior = Object.values(this.draft.deliveries).filter(
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
    this.append('delivery.recorded', cmd.at, cmd.actor, {
      delivery_id: deliveryId,
      asset_id: cmd.asset_id,
      target_ref: cmd.target_ref,
      target_type: cmd.target_type,
      version: a.content.sha256,
      attempt_no: prior.length + 1,
      delivered_by: cmd.actor,
      actor: cmd.actor,
    });
    return { ok: true, value: this.draft.deliveries[deliveryId] as DeliveryRow };
  }

  /**
   * Business-side delivery confirmation — the real world's answer to the
   * promise. confirmed closes the delivery; rejected is terminal for the
   * attempt and frees the (asset, target) slot for a retry attempt.
   */
  confirmDelivery(cmd: ConfirmDeliveryCommand): KernelResult<DeliveryRow> {
    const gate = this.guardPreconditions(
      cmd.expected_version,
      'confirm_delivery',
      cmd.actor,
      undefined,
      false,
    );
    if (!gate.ok) return gate;
    const dl = this.draft.deliveries[cmd.delivery_id];
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
    this.append('delivery.confirmed', cmd.at, cmd.actor, {
      delivery_id: cmd.delivery_id,
      outcome: cmd.outcome,
      confirmed_by: cmd.actor,
      actor: cmd.actor,
      ...(cmd.feedback === undefined ? {} : { feedback: cmd.feedback }),
    });
    return { ok: true, value: this.draft.deliveries[cmd.delivery_id] as DeliveryRow };
  }

  // -- private helpers -----------------------------------------------------

  /**
   * Shared command preconditions: actor must be a registered participant;
   * the expected-version equality guard (equality — not merely freshness —
   * is the pass condition, so two writers racing at the same version
   * cannot both succeed); project existence; the project-not-active gate
   * for exactly the four gated operation families; optional human-only and
   * non-empty-reason requirements.
   */
  private guardPreconditions(
    expectedVersion: number,
    action: string,
    actor: string,
    reason: string | undefined,
    humanOnly: boolean,
  ): KernelResult<void> {
    if (this.draft.participants[actor] === undefined) {
      return { ok: false, error: kernelErrors.forbidden(action, { reason: 'unknown-actor' }) };
    }
    const p = this.draft.project;
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
    const actorType = this.draft.participants[actor].type;
    if (humanOnly && actorType !== 'human') {
      return {
        ok: false,
        error: kernelErrors.forbidden(action, { actor_kind: actorType }),
      };
    }
    if (reason?.trim().length === 0) {
      return { ok: false, error: kernelErrors.rationaleRequired(action) };
    }
    return { ok: true, value: undefined };
  }

  private requireHuman(action: string, actor: string): KernelResult<void> {
    if (this.draft.participants[actor]?.type !== 'human') {
      return {
        ok: false,
        error: kernelErrors.forbidden(action, {
          actor_kind: this.draft.participants[actor]?.type ?? 'unknown',
        }),
      };
    }
    return { ok: true, value: undefined };
  }

  private blockingHoldIds(): readonly string[] {
    return Object.values(this.draft.holds)
      .filter((h) => alive(h) && h.status === 'active' && h.blocks_delivery)
      .map((h) => h.id);
  }

  private daysBetween(fromIso: string, toIso: string): number {
    // NaN propagates by design: every grace/purge comparison is written so
    // that NaN fails the threshold the same way an unelapsed window does.
    return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
  }

  /**
   * The single append+apply path. Computes seq (head+1) and the
   * post-event state_version (State-material events bump it; everything
   * else repeats), stamps the envelope schema_version, freezes via the
   * history, and folds the event through the replay applier into the live
   * draft. There is NO update or delete path — the surface is append-only.
   */
  private append(
    type: KernelEventType,
    at: string,
    actor: string | null,
    data: Record<string, unknown>,
  ): StateEvent {
    if (at.trim().length === 0) throw new Error('invalid event: missing logical time');
    const frozen = this.history.append({
      seq: this.history.currentSeq + 1,
      type,
      data,
      actor,
      at,
      state_version: STATE_MATERIAL_EVENTS.has(type) ? this.stateVersion + 1 : this.stateVersion,
      schema_version: STATE_EVENT_SCHEMA_VERSION,
    });
    applyEvent(this.draft, frozen);
    return frozen;
  }
}
