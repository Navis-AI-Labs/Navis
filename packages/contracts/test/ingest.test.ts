import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  UnsupportedIngestContractVersionError,
  encodeIngestResponse,
  ingestContractSchemaVersion,
  ingestEventSchema,
  ingestRejectionSchema,
  ingestRejectionTokens,
  ingestRequestSchema,
  ingestResponseSchema,
  parseIngestRequest,
} from '../src/ingest.js';

const DEVICE = '01924a61-7a1b-7c2d-8e3f-4a5b6c7d8e9f';

function eventId(i: number): string {
  return `01924a61-7a1b-7c2d-8e3f-${i.toString(16).padStart(12, '0')}`;
}

function batchOf(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    event_id: eventId(i),
    event: { index: i },
    payload_hash: undefined,
  }));
}

describe('ingestRequestSchema', () => {
  it('accepts a well-formed batch', () => {
    const parsed = ingestRequestSchema.safeParse({
      contract_version: 1,
      event_schema_version: 1,
      device_id: DEVICE,
      events: [{ event_id: eventId(0), event: { a: 1 } }],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty batch', () => {
    const parsed = ingestRequestSchema.safeParse({
      contract_version: 1,
      event_schema_version: 1,
      device_id: DEVICE,
      events: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a batch above the size limit', () => {
    const parsed = ingestRequestSchema.safeParse({
      contract_version: 1,
      event_schema_version: 1,
      device_id: DEVICE,
      events: batchOf(501),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an undeclared top-level field', () => {
    const parsed = ingestRequestSchema.safeParse({
      contract_version: 1,
      event_schema_version: 1,
      device_id: DEVICE,
      events: [{ event: {} }],
      surprise: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('parseIngestRequest version precheck', () => {
  it('refuses an unsupported contract version without touching events', () => {
    expect(() =>
      parseIngestRequest({
        contract_version: 2,
        event_schema_version: 1,
        device_id: DEVICE,
        events: [{ event: { a: 1 } }],
      }),
    ).toThrow(UnsupportedIngestContractVersionError);
  });

  it('accepts the supported contract version', () => {
    const request = parseIngestRequest({
      contract_version: 1,
      event_schema_version: 1,
      device_id: DEVICE,
      events: [{ event_id: eventId(0), event: { a: 1 } }],
    });
    expect(request.contract_version).toBe(ingestContractSchemaVersion);
  });
});

describe('ingestRejectionSchema', () => {
  it('accepts every token in the closed vocabulary', () => {
    for (const token of Object.values(ingestRejectionTokens)) {
      const parsed = ingestRejectionSchema.safeParse({
        index: 0,
        token,
        detail: 'why it failed',
        path: '/events/0',
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects an unknown token', () => {
    const parsed = ingestRejectionSchema.safeParse({ index: 0, token: 'ingest/made-up' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a negative index', () => {
    const parsed = ingestRejectionSchema.safeParse({
      index: -1,
      token: ingestRejectionTokens.schema_violation,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ingestEventSchema tolerance', () => {
  const EVENT_ID = '01924a61-7a1b-7c2d-8e3f-4a5b6c7d8e9f';

  it('keeps undeclared fields out of the parsed event', () => {
    const parsed = ingestEventSchema.safeParse({
      event_id: EVENT_ID,
      event: { a: 1 },
      future_field: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('future_field' in parsed.data).toBe(false);
    }
  });

  it('requires an event id', () => {
    const parsed = ingestEventSchema.safeParse({ event: { a: 1 } });
    expect(parsed.success).toBe(false);
  });

  it('accepts a causation link to the preceding event', () => {
    const parsed = ingestEventSchema.safeParse({
      event_id: EVENT_ID,
      causation_id: '01924a61-7a1b-7c2d-8e3f-4a5b6c7d8ea0',
      event: { a: 1 },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a well-formed payload hash claim', () => {
    const value = createHash('sha256').update('x').digest('hex');
    const parsed = ingestEventSchema.safeParse({
      event_id: EVENT_ID,
      event: { a: 1 },
      payload_hash: { algorithm: 'sha256', value },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a malformed hash value', () => {
    const parsed = ingestEventSchema.safeParse({
      event_id: EVENT_ID,
      event: { a: 1 },
      payload_hash: { algorithm: 'sha256', value: 'not-hex' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ingestResponseSchema', () => {
  it('accepts a response reporting acceptance, rejection, and duplicates together', () => {
    const parsed = ingestResponseSchema.safeParse({
      contract_version: 1,
      accepted: [0, 2],
      rejected: [
        { index: 1, token: ingestRejectionTokens.schema_violation, path: '/events/1/event' },
      ],
      duplicate: [3],
      event_results: [
        { index: 0, outcome: 'accepted' },
        {
          index: 1,
          outcome: 'rejected',
          rejection: { index: 1, token: ingestRejectionTokens.schema_violation },
        },
        { index: 2, outcome: 'accepted' },
        { index: 3, outcome: 'duplicate' },
      ],
      server_supported_contract_versions: [1],
      server_supported_event_schema_versions: [1],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts unknown additive fields (consumer tolerance)', () => {
    const parsed = ingestResponseSchema.safeParse({
      contract_version: 1,
      accepted: [],
      rejected: [],
      duplicate: [],
      event_results: [],
      server_supported_contract_versions: [1],
      server_supported_event_schema_versions: [1],
      future_extension: 42,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('encodeIngestResponse producer path', () => {
  it('validates and returns a well-formed response', () => {
    const response = encodeIngestResponse({
      contract_version: 1,
      accepted: [0],
      rejected: [],
      duplicate: [],
      event_results: [{ index: 0, outcome: 'accepted' }],
      server_supported_contract_versions: [1],
      server_supported_event_schema_versions: [1],
    });
    expect(response.accepted).toEqual([0]);
  });

  it('throws on a response with an undeclared top-level field', () => {
    expect(() =>
      encodeIngestResponse({
        contract_version: 1,
        accepted: [],
        rejected: [],
        duplicate: [],
        event_results: [],
        server_supported_contract_versions: [1],
        server_supported_event_schema_versions: [1],
        future_extension: 42,
      }),
    ).not.toThrow();
  });
});
