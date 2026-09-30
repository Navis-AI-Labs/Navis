import { describe, expect, it } from 'vitest';

import {
  bridgeHookContextSummarySchema,
  bridgeHookInvocationSchema,
  bridgeHookResultSchema,
  bridgeHookStateChangeSchema,
  bridgeHookUnboundReasons,
} from '../src/index.js';

const UUID = '01900000-0000-7000-8000-0000000000aa';
const TS = '2026-09-19T00:00:00.000Z';

const CONTEXT = {
  project_name: 'apollo-launch-checklist',
  project_status: 'active',
  state_version: 42,
  active_work_count: 3,
  open_hold_count: 1,
  last_update_at: TS,
} as const;

describe('bridgeHookInvocationSchema', () => {
  it('accepts a well-formed invocation with a toml', () => {
    expect(
      bridgeHookInvocationSchema.safeParse({
        hook: 'session.start',
        request_id: UUID,
        cwd: '/work/apollo',
        toml_present: true,
        toml_project_id: UUID,
      }).success,
    ).toBe(true);
  });

  it('accepts an invocation with no toml present', () => {
    expect(
      bridgeHookInvocationSchema.safeParse({
        hook: 'session.start',
        request_id: UUID,
        cwd: '/work/scratch',
        toml_present: false,
      }).success,
    ).toBe(true);
  });

  it('rejects a caller asserting project_id', () => {
    expect(
      bridgeHookInvocationSchema.safeParse({
        hook: 'session.start',
        request_id: UUID,
        cwd: '/work/apollo',
        toml_present: true,
        toml_project_id: UUID,
        project_id: UUID,
      }).success,
    ).toBe(false);
  });

  it('rejects any other hook verb', () => {
    expect(
      bridgeHookInvocationSchema.safeParse({
        hook: 'session.end',
        request_id: UUID,
        cwd: '/work/apollo',
        toml_present: true,
      }).success,
    ).toBe(false);
  });

  it('rejects extras and a missing cwd', () => {
    expect(
      bridgeHookInvocationSchema.safeParse({
        hook: 'session.start',
        request_id: UUID,
        toml_present: true,
        note: 'extra',
      }).success,
    ).toBe(false);
  });

  it('rejects a toml_project_id without toml_present', () => {
    expect(
      bridgeHookInvocationSchema.safeParse({
        hook: 'session.start',
        request_id: UUID,
        cwd: '/work/apollo',
        toml_present: false,
        toml_project_id: UUID,
      }).success,
    ).toBe(false);
  });
});

describe('bridgeHookResultSchema', () => {
  it('accepts bound with structured context', () => {
    const parsed = bridgeHookResultSchema.safeParse({
      status: 'bound',
      bound_source: 'toml',
      event_id: UUID,
      project_id: UUID,
      change_marker: 'advanced',
      context_summary: CONTEXT,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts bound with a no-change marker and no re-fetched summary', () => {
    expect(
      bridgeHookResultSchema.safeParse({
        status: 'bound',
        bound_source: 'binding-table',
        event_id: UUID,
        project_id: UUID,
        change_marker: 'unchanged',
        cached_at: TS,
      }).success,
    ).toBe(true);
  });

  it('accepts bound with a stale marker and a cache timestamp when offline', () => {
    expect(
      bridgeHookResultSchema.safeParse({
        status: 'bound',
        bound_source: 'manual-link',
        event_id: UUID,
        project_id: UUID,
        change_marker: 'stale',
        context_summary: CONTEXT,
        cached_at: TS,
      }).success,
    ).toBe(true);
  });

  it('accepts unbound with a closed-vocabulary reason', () => {
    for (const reason of Object.values(bridgeHookUnboundReasons)) {
      expect(bridgeHookResultSchema.safeParse({ status: 'unbound', reason }).success).toBe(true);
    }
  });

  it('rejects unbound with an unknown reason', () => {
    expect(bridgeHookResultSchema.safeParse({ status: 'unbound', reason: 'made-up' }).success).toBe(
      false,
    );
  });

  it('rejects unbound carrying a context summary', () => {
    expect(
      bridgeHookResultSchema.safeParse({
        status: 'unbound',
        reason: bridgeHookUnboundReasons.no_toml,
        context_summary: CONTEXT,
      }).success,
    ).toBe(false);
  });

  it('accepts reused returning the original event id', () => {
    expect(bridgeHookResultSchema.safeParse({ status: 'reused', event_id: UUID }).success).toBe(
      true,
    );
  });

  it('rejects the legacy started/failed statuses', () => {
    expect(bridgeHookResultSchema.safeParse({ status: 'started', pid: 4242 }).success).toBe(false);
    expect(bridgeHookResultSchema.safeParse({ status: 'failed', reason: 'x' }).success).toBe(false);
  });

  it('rejects reused without an event id', () => {
    expect(bridgeHookResultSchema.safeParse({ status: 'reused' }).success).toBe(false);
  });
});

describe('bridgeHookContextSummarySchema', () => {
  it('accepts the six structured fields', () => {
    expect(bridgeHookContextSummarySchema.safeParse(CONTEXT).success).toBe(true);
  });

  it('carries long structured content with no character cap', () => {
    expect(
      bridgeHookContextSummarySchema.safeParse({
        ...CONTEXT,
        project_name: 'a'.repeat(200),
      }).success,
    ).toBe(true);
  });

  it('rejects a prose summary field', () => {
    expect(
      bridgeHookContextSummarySchema.safeParse({
        ...CONTEXT,
        prose_summary: 'a long narrative',
      }).success,
    ).toBe(false);
  });
});

describe('bridgeHookStateChangeSchema', () => {
  it('is the closed three-value vocabulary', () => {
    expect(bridgeHookStateChangeSchema.options).toEqual(['advanced', 'unchanged', 'stale']);
  });
});
