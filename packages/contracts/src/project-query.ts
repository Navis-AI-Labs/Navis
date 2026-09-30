import { z } from 'zod';

import {
  instantWireSchema,
  labelWireSchema,
  stateVersionWireSchema,
  textWireSchema,
  uuidRefSchema,
} from './wire-primitives.js';

/**
 * Project query contract — the read surface the bridge daemon loads at
 * session start and a future web app renders.
 *
 * `get_project_state` returns the three time-planes projection assembled by
 * replaying the event ledger. It is never truncated or summarized to fit a
 * length budget: the caller decides what to consume.
 *
 * `load_context` is a paginated history slice with opaque cursors; the
 * caller never constructs a cursor, only returns the one it received.
 *
 * `search_projects` is membership-filtered: the response contains only
 * projects the caller's device may read, and the listing never reveals the
 * existence of a project the caller is not a member of.
 */

/** The project-query contract version this package supports. */
export const projectQueryContractSchemaVersion = 1;

/**
 * The three time-planes a project presents. History is what happened;
 * Current State is what is in force; Intended Direction is what is about to
 * change. The three are never silently merged into one summary.
 */
export const timePlaneSchema = z.enum(['history', 'current', 'intended']);

/**
 * One summary item in a time plane: an anchor to the ledger entry behind it
 * and a bounded label. The anchor is the authority; the label is a hint.
 */
export const timePlaneItemSchema = z
  .looseObject({
    anchor: z.strictObject({
      seq: z.number().int().min(1),
      event_type: labelWireSchema,
      occurred_at: instantWireSchema,
    }),
    label: textWireSchema,
  })
  .meta({ description: 'One item in a time plane.', id: 'TimePlaneItem' });

/** The three time planes of a project. */
export const projectStatePlanesSchema = z
  .strictObject({
    history: z.array(timePlaneItemSchema),
    current: z.array(timePlaneItemSchema),
    intended: z.array(timePlaneItemSchema),
  })
  .meta({ description: 'The three time planes of a project.', id: 'ProjectStatePlanes' });

/**
 * Structured context summary served at session start. Six fields, no
 * character cap: the caller consumes structure, not prose, and a summary
 * that cannot hold its own fields is not a summary.
 */
export const contextSummarySchema = z
  .strictObject({
    project_name: textWireSchema,
    project_status: labelWireSchema,
    state_version: stateVersionWireSchema,
    active_work_count: z.number().int().min(0),
    open_hold_count: z.number().int().min(0),
    last_update_at: instantWireSchema,
  })
  .meta({ description: 'Structured session-start context summary.', id: 'ContextSummary' });

/**
 * State-change marker carried beside the summary. The daemon records the
 * state version it last loaded; an unchanged version yields `unchanged` and
 * the summary is served from cache, not re-fetched from the ledger.
 */
export const stateChangeMarkerSchema = z.enum(['advanced', 'unchanged', 'stale']);

/**
 * `get_project_state` response. The projection is authoritative and
 * untruncated; `state_version` is the version the projection was assembled
 * at.
 */
export const projectStateResponseSchema = z
  .looseObject({
    project_id: uuidRefSchema,
    state_version: stateVersionWireSchema,
    planes: projectStatePlanesSchema,
    change_marker: stateChangeMarkerSchema,
    cached_at: instantWireSchema.optional(),
  })
  .meta({ description: 'Three time-planes projection of a project.', id: 'ProjectStateResponse' });

/** Event-type filter for `load_context`. */
export const contextFilterTypeSchema = z.enum([
  'boundary',
  'work',
  'hold',
  'acceptance',
  'delivery',
  'session',
]);

/** Filters a `load_context` request. At least one is required. */
export const contextFilterSchema = z
  .strictObject({
    types: z.array(contextFilterTypeSchema).min(1).max(32),
    from: instantWireSchema.optional(),
    to: instantWireSchema.optional(),
  })
  .meta({ description: 'Filters for a history context request.', id: 'ContextFilter' });

/**
 * `load_context` request. `cursor` is opaque — the caller only ever returns
 * a cursor the service issued.
 */
export const loadContextRequestSchema = z
  .strictObject({
    project_id: uuidRefSchema,
    filter: contextFilterSchema,
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.number().int().min(1).max(200),
  })
  .meta({ description: 'Paginated history context request.', id: 'LoadContextRequest' });

/** One ledger entry in a history context slice. */
export const contextEntrySchema = z
  .looseObject({
    seq: z.number().int().min(1),
    event_type: labelWireSchema,
    occurred_at: instantWireSchema,
    event_id: uuidRefSchema,
    summary: textWireSchema,
  })
  .meta({ description: 'One ledger entry in a history slice.', id: 'ContextEntry' });

/**
 * `load_context` response. When `has_more` is true, `next_cursor` fetches
 * the next page; the same cursor never returns overlapping entries.
 */
export const loadContextResponseSchema = z
  .looseObject({
    entries: z.array(contextEntrySchema),
    has_more: z.boolean(),
    next_cursor: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .meta({ description: 'Paginated history context slice.', id: 'LoadContextResponse' });

/** `search_projects` request. The membership filter is applied server-side, never client-side. */
export const searchProjectsRequestSchema = z
  .strictObject({
    query: labelWireSchema,
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.number().int().min(1).max(100),
  })
  .meta({ description: 'Project search request.', id: 'SearchProjectsRequest' });

/** One project in a search result. Never includes membership of other participants. */
export const projectSearchResultItemSchema = z
  .looseObject({
    project_id: uuidRefSchema,
    project_name: labelWireSchema,
    project_status: labelWireSchema,
    state_version: stateVersionWireSchema,
  })
  .meta({ description: 'One project in a search result.', id: 'ProjectSearchResultItem' });

export const searchProjectsResponseSchema = z
  .looseObject({
    results: z.array(projectSearchResultItemSchema),
    has_more: z.boolean(),
    next_cursor: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .meta({ description: 'Project search result page.', id: 'SearchProjectsResponse' });

export type ProjectStateResponse = z.infer<typeof projectStateResponseSchema>;
export type ProjectStatePlanes = z.infer<typeof projectStatePlanesSchema>;
export type TimePlaneItem = z.infer<typeof timePlaneItemSchema>;
export type ContextSummary = z.infer<typeof contextSummarySchema>;
export type ContextEntry = z.infer<typeof contextEntrySchema>;
export type ContextFilterType = z.infer<typeof contextFilterTypeSchema>;
export type LoadContextRequest = z.infer<typeof loadContextRequestSchema>;
export type LoadContextResponse = z.infer<typeof loadContextResponseSchema>;
export type SearchProjectsRequest = z.infer<typeof searchProjectsRequestSchema>;
export type SearchProjectsResponse = z.infer<typeof searchProjectsResponseSchema>;
export type ProjectSearchResultItem = z.infer<typeof projectSearchResultItemSchema>;
export type StateChangeMarker = z.infer<typeof stateChangeMarkerSchema>;

/**
 * Thrown when a query request declares a contract version this package does
 * not support. Version refusal is explicit, never a partial parse.
 */
export class UnsupportedProjectQueryContractVersionError extends Error {
  override readonly name = 'UnsupportedProjectQueryContractVersionError' as const;
  readonly received: number;
  readonly supported: number;
  constructor(received: number, supported: number) {
    super(
      `unsupported project-query contract_version: received ${String(received)}, supported up to ${String(supported)}`,
    );
    this.received = received;
    this.supported = supported;
  }
}

/* Version precheck: refuse an unsupported contract version before any query
 * parameter is interpreted. */
const projectQueryVersionProbeSchema = z.looseObject({
  contract_version: z.number().int().positive(),
});

/** Consumer path for a query request. */
export function parseProjectQueryRequest(input: unknown): unknown {
  const probe = projectQueryVersionProbeSchema.safeParse(input);
  if (probe.success && probe.data.contract_version > projectQueryContractSchemaVersion) {
    throw new UnsupportedProjectQueryContractVersionError(
      probe.data.contract_version,
      projectQueryContractSchemaVersion,
    );
  }
  return input;
}
