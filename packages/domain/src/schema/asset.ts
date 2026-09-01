import { z } from 'zod';

import { textSchema } from './text.js';
import { instantSchema } from './time.js';
import { uuidSchema } from './ids.js';
import { type SchemaError, schemaErrors } from '../errors/schema.js';

/**
 * Asset — referencable content with scope, provenance, and lifecycle.
 *
 * The transition table below carries the 11 legal pairs of the accepted
 * lifecycle: rejected is terminal, and purge sits behind a double-condition
 * gate (age threshold plus explicit human confirmation).
 */

export const assetKindSchema = z
  .enum(['context', 'knowledge', 'experience', 'skill', 'artifact', 'evidence', 'template'])
  .meta({ description: 'Asset kind (baseline seven-value enum).', id: 'AssetKind' });

export const assetScopeSchema = z
  .enum(['participant', 'session', 'task', 'project', 'organization'])
  .meta({ description: 'Asset sedimentation scope (baseline five-level enum).', id: 'AssetScope' });

export const assetLifecycleSchema = z
  .enum([
    'candidate',
    'active',
    'superseded',
    'competitive_superseded',
    'deprecated',
    'archived',
    'rejected',
  ])
  .meta({
    description: 'Asset lifecycle state (baseline seven-value enum).',
    id: 'AssetLifecycle',
  });

export const assetContentStorageSchema = z
  .enum(['inline', 'object_ref', 'local_ref', 'external_ref'])
  .meta({ description: 'Where the asset content physically lives.', id: 'AssetContentStorage' });

export const assetContentSchema = z
  .strictObject({
    media_type: z.string().min(1).max(255),
    storage: assetContentStorageSchema,
    ref: z.string().min(1).max(2048).optional(),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    sha256: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  /**
   * ref points at content stored outside the event stream: an Object Storage
   * key, a Bridge-local path hash, or an external URL — one per the storage
   * kind. inline content lives inside event payloads and points at nothing,
   * so inline forbids ref; every other storage kind requires it.
   */
  .refine((v) => (v.storage === 'inline' ? v.ref === undefined : v.ref !== undefined), {
    path: ['ref'],
    error:
      'ref is required unless storage is inline (inline content lives in event payloads and points nowhere), and forbidden when storage is inline',
  })
  .meta({
    description: 'Physical carrier of the asset content (media type, storage location, integrity).',
    id: 'AssetContent',
  });

export const assetSchema = z
  .strictObject({
    id: uuidSchema,
    deleted_at: instantSchema.nullable().optional(),
    // event-derived read cache; writable only by the projection replay path
    updated_at: instantSchema.nullable().optional(),
    updated_by: uuidSchema.nullable().optional(),
    created_at: instantSchema,
    // ref Project; required unless scope=organization
    project_id: uuidSchema.optional(),
    kind: assetKindSchema,
    scope: assetScopeSchema,
    provenance: textSchema.optional(),
    lifecycle: assetLifecycleSchema,
    content: assetContentSchema.optional(),
    // reserved dual-temporal window, inert until enabled by a later change
    valid_from: instantSchema.nullable().optional(),
    valid_to: instantSchema.nullable().optional(),
  })
  /** Ownership anchor: every asset belongs to a project unless it sediments at organization scope. */
  .refine((v) => v.scope === 'organization' || !!v.project_id, {
    path: ['project_id'],
    error: 'project_id is required unless scope is organization',
  })
  .meta({
    description:
      'Referencable content with scope, provenance, lifecycle, and optional physical carrier.',
    id: 'Asset',
  });

export type Asset = z.infer<typeof assetSchema>;
export type AssetKind = z.infer<typeof assetKindSchema>;
export type AssetScope = z.infer<typeof assetScopeSchema>;
export type AssetLifecycle = z.infer<typeof assetLifecycleSchema>;
export type AssetContent = z.infer<typeof assetContentSchema>;
export type AssetContentStorage = z.infer<typeof assetContentStorageSchema>;

/** Days an archived asset must age before purge eligibility; the gate below is this constant's only consumer. */
export const PURGE_AGE_THRESHOLD_DAYS = 180;

/**
 * Legal transitions exactly as accepted.
 *
 * Archived purges through the gate in `assertTransition`; rejected is
 * terminal; contested is unreachable in this change.
 */
const LEGAL_TRANSITIONS: Readonly<Record<AssetLifecycle, readonly AssetLifecycle[]>> =
  Object.freeze({
    candidate: Object.freeze(['active', 'rejected'] as const),
    active: Object.freeze([
      'superseded',
      'competitive_superseded',
      'deprecated',
      'archived',
    ] as const),
    superseded: Object.freeze(['archived'] as const),
    competitive_superseded: Object.freeze(['active', 'archived'] as const),
    deprecated: Object.freeze(['archived'] as const),
    archived: Object.freeze([] as const),
    rejected: Object.freeze([] as const),
  });

export interface PurgeGateInput {
  readonly daysArchived: number;
  readonly doubleConfirmation: boolean;
}

export type TransitionResult =
  { readonly ok: true } | { readonly ok: false; readonly error: SchemaError };

/**
 * Checks a lifecycle transition.
 *
 * Regular pairs are looked up in the table; archived→purged requires the
 * double-condition gate; contested is rejected as not-enabled.
 */
export function assertTransition(
  from: AssetLifecycle,
  to: AssetLifecycle,
  purgeGate?: PurgeGateInput,
): TransitionResult {
  if (!assetLifecycleSchema.safeParse(from).success) {
    return { ok: false, error: schemaErrors.illegalTransition(from, to) };
  }
  // gate outcomes checked before enum validation: purged is an outcome, contested is unreachable
  if (to === ('purged' as AssetLifecycle)) {
    if (from !== 'archived') {
      return { ok: false, error: schemaErrors.illegalTransition(from, to) };
    }
    const days = purgeGate?.daysArchived ?? 0;
    const confirmed = purgeGate?.doubleConfirmation ?? false;
    if (days < PURGE_AGE_THRESHOLD_DAYS || !confirmed) {
      return {
        ok: false,
        error: schemaErrors.purgeConditionsUnmet(days, confirmed, PURGE_AGE_THRESHOLD_DAYS),
      };
    }
    return { ok: true };
  }
  if (to === ('contested' as AssetLifecycle)) {
    return { ok: false, error: schemaErrors.notEnabled('contested') };
  }
  if (!assetLifecycleSchema.safeParse(to).success) {
    return { ok: false, error: schemaErrors.illegalTransition(from, to) };
  }
  const legal = LEGAL_TRANSITIONS[from];
  if (!legal.includes(to)) {
    return { ok: false, error: schemaErrors.illegalTransition(from, to) };
  }
  return { ok: true };
}
