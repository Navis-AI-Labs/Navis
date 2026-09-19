import { describe, expect, it } from 'vitest';

import { bridgeHookInvocationSchema, bridgeHookResultSchema } from '../src/index.js';

const UUID = '01900000-0000-7000-8000-0000000000aa';
const TS = '2026-09-19T00:00:00.000Z';

describe('bridgeHookInvocationSchema', () => {
  it('accepts a well-formed invocation', () => {
    expect(
      bridgeHookInvocationSchema.safeParse({
        hook: 'session.start',
        project_id: UUID,
        request_id: UUID,
      }).success,
    ).toBe(true);
  });

  it('rejects any other hook verb', () => {
    expect(
      bridgeHookInvocationSchema.safeParse({
        hook: 'session.end',
        project_id: UUID,
        request_id: UUID,
      }).success,
    ).toBe(false);
  });

  it('rejects extras and malformed ids', () => {
    expect(
      bridgeHookInvocationSchema.safeParse({
        hook: 'session.start',
        project_id: UUID,
        request_id: UUID,
        note: 'extra',
      }).success,
    ).toBe(false);
  });
});

describe('bridgeHookResultSchema', () => {
  it('accepts started with pid', () => {
    expect(
      bridgeHookResultSchema.safeParse({ status: 'started', pid: 4242, recorded_at: TS }).success,
    ).toBe(true);
  });

  it('accepts reused with pid', () => {
    expect(
      bridgeHookResultSchema.safeParse({ status: 'reused', pid: 4242, recorded_at: TS }).success,
    ).toBe(true);
  });

  it('accepts failed with reason, without pid', () => {
    expect(
      bridgeHookResultSchema.safeParse({
        status: 'failed',
        reason: 'socket bound by another process',
        recorded_at: TS,
      }).success,
    ).toBe(true);
  });

  it('rejects started without pid and failed without reason', () => {
    expect(bridgeHookResultSchema.safeParse({ status: 'started', recorded_at: TS }).success).toBe(
      false,
    );
    expect(bridgeHookResultSchema.safeParse({ status: 'failed', recorded_at: TS }).success).toBe(
      false,
    );
  });
});
