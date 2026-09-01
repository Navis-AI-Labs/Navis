import { describe, expect, it } from 'vitest';

import { eventEnvelopeSchema } from '../src/ports/event-store.js';
import { uuidv7 } from '../src/schema/ids.js';

describe('event envelope schema (domain port layer)', () => {
  const valid = () => ({
    event_id: uuidv7(),
    project_id: uuidv7(),
    seq: 1,
    aggregate_type: 'project',
    aggregate_id: uuidv7(),
    aggregate_revision: 1,
    event_type: 'project.created',
    event_schema_version: 1,
    occurred_at: '2026-08-31T00:00:00.000Z',
    recorded_at: '2026-08-31T00:00:00.000Z',
    payload: {},
    metadata: {},
    privacy_class: 'evidence' as const,
    state_version: 1,
  });

  it('parses a valid envelope', () => {
    const result = eventEnvelopeSchema.safeParse(valid());
    expect(result.success).toBe(true);
  });

  it('rejects a non-v7 event_id and an unknown privacy_class', () => {
    expect(
      eventEnvelopeSchema.safeParse({
        ...valid(),
        event_id: '550e8400-e29b-41d4-a716-446655440000',
      }).success,
    ).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...valid(), privacy_class: 'chat' }).success).toBe(
      false,
    );
    expect(eventEnvelopeSchema.safeParse({ ...valid(), seq: 0 }).success).toBe(false);
  });

  it('rejects unknown keys (strict envelope)', () => {
    expect(eventEnvelopeSchema.safeParse({ ...valid(), extra: 1 }).success).toBe(false);
  });
});
