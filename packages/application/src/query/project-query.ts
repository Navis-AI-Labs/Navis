/**
 * The query read face: assembles the three time planes and the paginated
 * history slice from the event ledger, and the project directory page from
 * the membership table. All three are read-only; no command path runs here.
 *
 * The time planes are a *projection of the ledger*, never a summary the
 * service invents: the plane rows are anchored to seq + event_type +
 * occurred_at, and the caller decides what to consume. The replay path is
 * the audit — `getProjectState` returns exactly what a full replay of the
 * same ledger produces (standard 06: replay consistency).
 */

import type { EventEnvelope, EventStore } from '@navis/domain';
import { ProjectStateKernel } from '@navis/domain';
import type {
  ContextEntry,
  ContextFilterType,
  LoadContextRequest,
  ProjectSearchResultItem,
  ProjectStateResponse,
  SearchProjectsRequest,
  SearchProjectsResponse,
  TimePlaneItem,
} from '@navis/contracts';

/**
 * The filter type → event-prefix table. A filter type admits an event when
 * the event type starts with the family prefix. 'session' is the exception:
 * session events are the intervention family, and they carry the session's
 * own vocabulary (`intervention.session_*`).
 */
const FILTER_PREFIXES: Readonly<Record<ContextFilterType, readonly string[]>> = {
  boundary: ['project.boundary_updated'],
  work: ['work.', 'workrun.'],
  hold: ['hold.'],
  acceptance: ['acceptance.'],
  delivery: ['delivery.'],
  session: ['intervention.'],
};

/** A ledger entry admitted by the filter: seq + the sort keys the cursor rides. */
interface ContextRow {
  readonly seq: number;
  readonly event_id: string;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly summary: string;
}

/**
 * Cursor payload for `load_context`. Opaque to the client — the service
 * issues it and the service decodes it; the caller only ever returns it.
 */
interface ContextCursor {
  readonly seq: number;
}

/** The base64 alphabet the contract's cursor regex admits: urlsafe, no padding. */
function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url').replace(/=+$/u, '');
}

function decodeCursor(cursor: string): ContextCursor {
  const json = Buffer.from(cursor, 'base64url').toString('utf8');
  const parsed = JSON.parse(json) as { seq?: unknown };
  const seq = parsed.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    throw new Error('invalid context cursor');
  }
  return { seq };
}

/** Folds the envelope into the row a history slice serves. */
function toContextRow(envelope: EventEnvelope): ContextRow {
  return {
    seq: envelope.seq,
    event_id: envelope.event_id,
    event_type: envelope.event_type,
    occurred_at: envelope.occurred_at,
    summary: labelOf(envelope),
  };
}

/** True when the envelope's family is one the filter admits. */
function admits(filter: ContextFilterType, envelope: EventEnvelope): boolean {
  return FILTER_PREFIXES[filter].some((prefix) => envelope.event_type.startsWith(prefix));
}

/**
 * Rebuilds the projection from the ledger. The snapshot is a cache: when the
 * store holds one whose cursor is the ledger head, the kernel seeds from it
 * and folds the tail; otherwise the whole log replays. Either path yields
 * the same projection — that equivalence is the replay invariant the kernel
 * itself verifies (`verifyIntegrity`).
 */
async function rebuildProjection(
  store: EventStore,
  projectId: string,
): Promise<{ stateVersion: number }> {
  // the kernel rebuilds from the full log: the causal clock needs every
  // authorship event, and the replay path is the audit that the planes and
  // the version agree
  const full = await store.loadEvents(projectId, 0);
  const kernel = ProjectStateKernel.fromEvents(
    full.map((e) => ({
      seq: e.seq,
      type: e.event_type,
      data: e.payload,
      actor: e.actor_participant_id ?? null,
      at: e.occurred_at,
      state_version: e.state_version,
      schema_version: e.event_schema_version,
    })),
  );
  return { stateVersion: kernel.stateVersion };
}

/** Anchors a plane item at its ledger entry. */
function planeItem(
  seq: number,
  event_type: string,
  occurred_at: string,
  label: string,
): TimePlaneItem {
  return { anchor: { seq, event_type, occurred_at }, label };
}

/**
 * The plane admission tables. A plane is the ledger entries of its families,
 * ordered by seq — the anchor is the entry itself, so the caller can always
 * re-fetch the exact event behind a plane item. Policy updates are excluded
 * from History: the boundary arc is what the plane is for, and policy churn
 * would bury it.
 */
const HISTORY_FAMILIES = ['project.', 'participant.'];
const CURRENT_FAMILIES = ['work.', 'workrun.', 'hold.'];
const INTENDED_FAMILIES = ['direction.proposed'];

/** True when the event type starts with any of the families. */
function inFamilies(families: readonly string[], eventType: string): boolean {
  return families.some((prefix) => eventType.startsWith(prefix));
}

/**
 * `get_project_state`: the three time-planes projection, assembled by
 * replaying the event ledger. The planes are ledger entries — seq +
 * event_type + occurred_at are the anchor, the label is a hint — and the
 * replay path is the audit: the state version equals a full replay of the
 * same log (standard 06).
 */
export async function getProjectState(
  store: EventStore,
  projectId: string,
): Promise<ProjectStateResponse> {
  const { stateVersion } = await rebuildProjection(store, projectId);
  const events = await store.loadEvents(projectId, 0);
  const planes = {
    history: events
      .filter((e) => inFamilies(HISTORY_FAMILIES, e.event_type))
      .filter((e) => e.event_type !== 'project.policy_updated')
      .map((e) => planeItem(e.seq, e.event_type, e.occurred_at, labelOf(e))),
    current: events
      .filter((e) => inFamilies(CURRENT_FAMILIES, e.event_type))
      .map((e) => planeItem(e.seq, e.event_type, e.occurred_at, labelOf(e))),
    intended: events
      .filter((e) => inFamilies(INTENDED_FAMILIES, e.event_type))
      .map((e) => planeItem(e.seq, e.event_type, e.occurred_at, labelOf(e))),
  };
  return {
    project_id: projectId,
    state_version: stateVersion,
    planes,
    change_marker: 'advanced',
  };
}

/** A bounded label for one ledger entry; the anchor is the authority. */
function labelOf(envelope: EventEnvelope): string {
  const data = envelope.payload as Record<string, unknown>;
  const title = data['title'];
  if (typeof title === 'string') return title;
  const reason = data['reason'];
  if (typeof reason === 'string') return reason;
  return envelope.event_type;
}

/**
 * `load_context`: a paginated, type- and time-filtered slice of history with
 * opaque cursors. Pagination rides `seq` — the ledger's own order — so pages
 * never overlap and a re-read at the same cursor is a no-op.
 */
export async function loadContext(
  store: EventStore,
  request: LoadContextRequest,
): Promise<LoadContextResponseShape> {
  const afterSeq = request.cursor === undefined ? 0 : decodeCursor(request.cursor).seq;
  const from = request.filter.from;
  const to = request.filter.to;
  const rows = (await store.loadEvents(request.project_id, afterSeq))
    .filter((e) => e.seq > afterSeq)
    .filter((e) => request.filter.types.some((t) => admits(t, e)))
    .filter((e) => from === undefined || e.occurred_at >= from)
    .filter((e) => to === undefined || e.occurred_at <= to)
    .map(toContextRow)
    .slice(0, request.limit + 1); // +1 to detect a next page without a second round trip
  const hasMore = rows.length > request.limit;
  const page = hasMore ? rows.slice(0, request.limit) : rows;
  const entries: ContextEntry[] = page.map((row) => ({
    seq: row.seq,
    event_type: row.event_type,
    occurred_at: row.occurred_at,
    event_id: row.event_id,
    summary: row.summary,
  }));
  const last = page[page.length - 1];
  const nextCursor = hasMore && last !== undefined ? encodeCursor({ seq: last.seq }) : undefined;
  return { entries, has_more: hasMore, next_cursor: nextCursor };
}

/**
 * The response shape `loadContext` returns: the contract type's optional
 * cursor made explicit for exactOptionalPropertyTypes.
 */
interface LoadContextResponseShape {
  entries: ContextEntry[];
  has_more: boolean;
  next_cursor: string | undefined;
}

/**
 * `search_projects`: projects the caller's participant may read, filtered
 * server-side by membership. The route resolves the participant from the
 * device key; this use case never trusts a client-supplied participant id.
 */
export async function searchProjects(
  directory: ProjectDirectoryLike,
  participantId: string,
  request: SearchProjectsRequest,
): Promise<SearchProjectsResponse> {
  const page = await directory.search(
    participantId,
    request.query,
    request.limit,
    request.cursor === undefined ? null : decodeProjectCursor(request.cursor),
  );
  const results: ProjectSearchResultItem[] = page.results.map((r) => ({
    project_id: r.project_id,
    project_name: r.title,
    project_status: r.status,
    state_version: r.state_version,
  }));
  return {
    results,
    has_more: page.has_more,
    next_cursor:
      page.next_cursor === null
        ? undefined
        : encodeCursor({ title: page.next_cursor.title, id: page.next_cursor.project_id }),
  };
}

/** The directory port, narrowed to what the use case calls. */
interface ProjectDirectoryLike {
  search(
    participantId: string,
    query: string,
    limit: number,
    cursor: { title: string; project_id: string } | null,
  ): Promise<{
    results: readonly {
      project_id: string;
      title: string;
      status: string;
      state_version: number;
    }[];
    has_more: boolean;
    next_cursor: { title: string; project_id: string } | null;
  }>;
}

function decodeProjectCursor(cursor: string): { title: string; project_id: string } {
  const json = Buffer.from(cursor, 'base64url').toString('utf8');
  const parsed = JSON.parse(json) as { title?: unknown; id?: unknown };
  const title = parsed.title;
  const projectId = parsed.id;
  if (typeof title !== 'string' || typeof projectId !== 'string') {
    throw new Error('invalid project cursor');
  }
  return { title, project_id: projectId };
}
