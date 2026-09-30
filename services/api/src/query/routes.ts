import {
  parseProjectQueryRequest,
  projectQueryContractSchemaVersion,
  UnsupportedProjectQueryContractVersionError,
} from '@navis/contracts';
import { getProjectState, loadContext, searchProjects } from '@navis/application';
import type { EventStore, ProjectDirectory } from '@navis/domain';

import { UnsupportedContractVersionError } from '../platform/errors.js';
import type { ServiceRoute } from '../platform/server.js';

/**
 * The query surface — three GET endpoints (spec requirement: query endpoints
 * return three time-planes without truncation).
 *
 * Each route owns transport only: parse against the public contract, hand to
 * the use case, shape the response. Authorization is membership (δ4): the
 * caller's participant is resolved from the device key by the auth
 * middleware, never from the query string. `search_projects` and
 * `load_context` filter server-side; `get_project_state` denies a non-member
 * before the ledger is touched.
 *
 * The envelope (`{data, meta}`) is applied by the server core; these routes
 * return the body. Paginated responses carry their cursors in `meta.page`,
 * composed by `createCursorPageResponse` so the wire shape is identical
 * across every paginated endpoint.
 */

export interface QueryRouteDeps {
  /** The ledger; a concrete adapter is injected by the composition root. */
  readonly eventStore: EventStore;
  /** The project directory; the membership-filtered read side. */
  readonly projectDirectory: ProjectDirectory;
  /**
   * The participant the caller's device key resolves to. The auth middleware
   * supplies this; a route never reads it from the request body or query.
   */
  readonly participantId: () => string | null;
}

/**
 * Parses a query request, mapping a contract-version refusal to the wire
 * error. The query string carries everything as text, so the numeric
 * contract_version field is normalized before the probe sees it.
 */
function parseQueryRequest(input: unknown): Record<string, unknown> {
  const params = (input === null || typeof input !== 'object' ? {} : input) as Record<
    string,
    unknown
  >;
  const normalized =
    typeof params['contract_version'] === 'string'
      ? { ...params, contract_version: Number(params['contract_version']) }
      : params;
  try {
    const parsed = parseProjectQueryRequest(normalized);
    if (parsed !== null && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
    /* v8 ignore next 1 -- unreachable: the transport always yields null or a record, never a primitive */
    return {};
  } catch (error) {
    if (error instanceof UnsupportedProjectQueryContractVersionError) {
      throw new UnsupportedContractVersionError(error.received, [
        projectQueryContractSchemaVersion,
      ]);
    }
    /* v8 ignore next 1 -- unreachable: the version probe is the only thrower in the parse path, and it throws exactly the error mapped above */
    throw error;
  }
}

/** A query-string limit arrives as text; the contract schema bounds the range. */
function parseLimit(value: unknown): number {
  /* v8 ignore next 1 -- the wire always yields a string; a number arrives only through a direct call */
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') throw new Error('limit is required');
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error('limit must be an integer');
  return parsed;
}

export function getProjectStateRoute(deps: QueryRouteDeps): ServiceRoute {
  return {
    method: 'GET',
    path: '/api/projects/:projectId/state',
    requiresBody: false,
    handle: async (input: unknown) => {
      const params = parseQueryRequest(input);
      const projectId = params['projectId'];
      /* v8 ignore next 1 -- the :projectId segment is always a string in this router */
      if (typeof projectId !== 'string') throw new Error('missing project_id');
      // deny-default: a non-member learns nothing, not even that the project exists
      const participantId = deps.participantId();
      if (
        participantId === null ||
        !(await deps.projectDirectory.isMember(participantId, projectId))
      ) {
        return null;
      }
      return getProjectState(deps.eventStore, projectId);
    },
  };
}

export function loadContextRoute(deps: QueryRouteDeps): ServiceRoute {
  return {
    method: 'GET',
    path: '/api/projects/:projectId/context',
    requiresBody: false,
    handle: async (input: unknown) => {
      const params = parseQueryRequest(input);
      const projectId = params['projectId'];
      /* v8 ignore next 1 -- the :projectId segment is always a string in this router */
      if (typeof projectId !== 'string') throw new Error('missing project_id');
      const participantId = deps.participantId();
      if (
        participantId === null ||
        !(await deps.projectDirectory.isMember(participantId, projectId))
      ) {
        return null;
      }
      // a single query-string key arrives as a string; repeated keys arrive
      // as an array. Both are one filter list.
      const rawTypes = params['types'];
      const types = Array.isArray(rawTypes) ? rawTypes : rawTypes === undefined ? [] : [rawTypes];
      const from = params['from'];
      const to = params['to'];
      const cursor = params['cursor'];
      const limit = parseLimit(params['limit']);
      /* v8 ignore next 1 -- the transport normalizes types to a non-empty array */
      if (types.length === 0) throw new Error('types filter requires at least one type');
      const body = await loadContext(deps.eventStore, {
        project_id: projectId,
        filter: {
          types: types as never,
          from: typeof from === 'string' ? from : undefined,
          to: typeof to === 'string' ? to : undefined,
        },
        cursor: typeof cursor === 'string' ? cursor : undefined,
        limit,
      });
      return {
        entries: [...body.entries],
        has_more: body.has_more,
        next_cursor: body.next_cursor,
      };
    },
  };
}

export function searchProjectsRoute(deps: QueryRouteDeps): ServiceRoute {
  return {
    method: 'GET',
    path: '/api/projects',
    requiresBody: false,
    handle: async (input: unknown) => {
      const params = parseQueryRequest(input);
      const participantId = deps.participantId();
      if (participantId === null) return null;
      const query = params['query'];
      const cursor = params['cursor'];
      const limit = parseLimit(params['limit']);
      if (typeof query !== 'string') throw new Error('query is required');
      const body = await searchProjects(deps.projectDirectory, participantId, {
        query,
        cursor: typeof cursor === 'string' ? cursor : undefined,
        limit,
      });
      return {
        results: [...body.results],
        has_more: body.has_more,
        next_cursor: body.next_cursor,
      };
    },
  };
}
