import { describe, expect, it } from 'vitest';

import {
  UnsupportedProjectQueryContractVersionError,
  contextFilterSchema,
  contextSummarySchema,
  loadContextRequestSchema,
  loadContextResponseSchema,
  parseProjectQueryRequest,
  projectQueryContractSchemaVersion,
  projectStateResponseSchema,
  searchProjectsRequestSchema,
  stateChangeMarkerSchema,
} from '../src/project-query.js';

const PROJECT = '01924c61-7a1b-7c2d-8e3f-4a5b6c7d8e9f';

describe('contextSummarySchema', () => {
  it('accepts the six structured fields', () => {
    const parsed = contextSummarySchema.safeParse({
      project_name: 'apollo-launch-checklist',
      project_status: 'active',
      state_version: 42,
      active_work_count: 3,
      open_hold_count: 1,
      last_update_at: '2026-09-26T08:30:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('carries long structured content without a character cap', () => {
    const parsed = contextSummarySchema.safeParse({
      project_name: 'a'.repeat(128),
      project_status: 'active',
      state_version: 42,
      active_work_count: 3,
      open_hold_count: 1,
      last_update_at: '2026-09-26T08:30:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an undeclared field', () => {
    const parsed = contextSummarySchema.safeParse({
      project_name: 'x',
      project_status: 'active',
      state_version: 42,
      active_work_count: 3,
      open_hold_count: 1,
      last_update_at: '2026-09-26T08:30:00.000Z',
      prose_summary: 'a long narrative that does not belong',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a negative state version', () => {
    const parsed = contextSummarySchema.safeParse({
      project_name: 'x',
      project_status: 'active',
      state_version: -1,
      active_work_count: 3,
      open_hold_count: 1,
      last_update_at: '2026-09-26T08:30:00.000Z',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('stateChangeMarkerSchema', () => {
  it('is the closed three-value vocabulary', () => {
    expect(stateChangeMarkerSchema.options).toEqual(['advanced', 'unchanged', 'stale']);
  });
});

describe('projectStateResponseSchema', () => {
  it('accepts a full three-planes projection', () => {
    const parsed = projectStateResponseSchema.safeParse({
      project_id: PROJECT,
      state_version: 42,
      planes: {
        history: [
          {
            anchor: { seq: 1, event_type: 'boundary.set', occurred_at: '2026-09-20T08:30:00.000Z' },
            label: 'initial boundary',
          },
        ],
        current: [
          {
            anchor: { seq: 40, event_type: 'hold.opened', occurred_at: '2026-09-25T08:30:00.000Z' },
            label: 'open hold on acceptance criteria',
          },
        ],
        intended: [
          {
            anchor: {
              seq: 42,
              event_type: 'work.started',
              occurred_at: '2026-09-26T08:30:00.000Z',
            },
            label: 'verification work in flight',
          },
        ],
      },
      change_marker: 'advanced',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a projection missing a plane', () => {
    const parsed = projectStateResponseSchema.safeParse({
      project_id: PROJECT,
      state_version: 42,
      planes: { history: [], current: [] },
      change_marker: 'advanced',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a stale marker with a cache timestamp', () => {
    const parsed = projectStateResponseSchema.safeParse({
      project_id: PROJECT,
      state_version: 42,
      planes: { history: [], current: [], intended: [] },
      change_marker: 'stale',
      cached_at: '2026-09-26T08:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('contextFilterSchema', () => {
  it('requires at least one type', () => {
    expect(contextFilterSchema.safeParse({ types: [] }).success).toBe(false);
    expect(contextFilterSchema.safeParse({ types: ['work'] }).success).toBe(true);
  });

  it('rejects an unknown type', () => {
    expect(contextFilterSchema.safeParse({ types: ['secret'] }).success).toBe(false);
  });
});

describe('loadContextRequestSchema', () => {
  it('accepts a filtered, bounded request', () => {
    const parsed = loadContextRequestSchema.safeParse({
      project_id: PROJECT,
      filter: { types: ['work', 'hold'], from: '2026-09-20T00:00:00.000Z' },
      limit: 50,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a limit above the bound', () => {
    const parsed = loadContextRequestSchema.safeParse({
      project_id: PROJECT,
      filter: { types: ['work'] },
      limit: 201,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a cursor the client constructed', () => {
    const parsed = loadContextRequestSchema.safeParse({
      project_id: PROJECT,
      filter: { types: ['work'] },
      cursor: 'not opaque!',
      limit: 50,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('loadContextResponseSchema', () => {
  it('reports has_more with an opaque next cursor', () => {
    const parsed = loadContextResponseSchema.safeParse({
      entries: [
        {
          seq: 40,
          event_type: 'hold.opened',
          occurred_at: '2026-09-25T08:30:00.000Z',
          event_id: '01924c61-7a1c-7c2d-8e3f-4a5b6c7d8e9f',
          summary: 'hold opened',
        },
      ],
      has_more: true,
      next_cursor: 'YWJjZA',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a final page without a cursor', () => {
    const parsed = loadContextResponseSchema.safeParse({ entries: [], has_more: false });
    expect(parsed.success).toBe(true);
  });
});

describe('searchProjectsRequestSchema', () => {
  it('accepts a bounded query', () => {
    expect(searchProjectsRequestSchema.safeParse({ query: 'apollo', limit: 20 }).success).toBe(
      true,
    );
  });

  it('rejects an empty query', () => {
    expect(searchProjectsRequestSchema.safeParse({ query: '', limit: 20 }).success).toBe(false);
  });
});

describe('contract version', () => {
  it('is v1', () => {
    expect(projectQueryContractSchemaVersion).toBe(1);
  });
});

describe('parseProjectQueryRequest version precheck', () => {
  it('refuses an unsupported contract version before any query parameter is interpreted', () => {
    expect(() =>
      parseProjectQueryRequest({
        contract_version: 99,
        project_id: PROJECT,
        filter: { types: [] },
      }),
    ).toThrow(UnsupportedProjectQueryContractVersionError);
  });

  it('passes a supported contract version through untouched', () => {
    const input = { contract_version: 1, note: 'shape only' };
    expect(parseProjectQueryRequest(input)).toBe(input);
  });

  it('does not refuse a request whose version field is malformed', () => {
    expect(parseProjectQueryRequest({ contract_version: null })).toEqual({
      contract_version: null,
    });
  });
});
