import { describe, expect, it } from 'vitest';

import {
  type CanonicalWorkEvent,
  UnsupportedWorkEventVersionError,
  canonicalWorkEventSchema,
  canonicalWorkEventSchemaVersion,
  canonicalWorkEventStrictSchema,
  canonicalWorkEventTypeSchema,
  encodeCanonicalWorkEvent,
  parseCanonicalWorkEvent,
} from '../src/work-event.js';
import { canonicalWorkEventFixtures } from './work-event.fixtures.js';

const PRIVACY_HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

interface PrivacyPayload {
  privacy: Record<string, unknown>;
}

function privacyOf(event: CanonicalWorkEvent): Record<string, unknown> {
  return (event.payload as PrivacyPayload).privacy;
}

function fixtureOfType(type: string): CanonicalWorkEvent {
  const found = canonicalWorkEventFixtures.find((f) => f.event_type === type);
  if (!found) throw new Error(`missing fixture for ${type}`);
  return found;
}

describe('canonical work event envelope', () => {
  it('accepts one golden fixture per event_type and round-trips lossless', () => {
    expect(canonicalWorkEventFixtures).toHaveLength(canonicalWorkEventTypeSchema.options.length);
    for (const fixture of canonicalWorkEventFixtures) {
      expect(parseCanonicalWorkEvent(fixture)).toEqual(fixture);
    }
  });

  it('rejects each missing provenance field with the field named', () => {
    const base = { ...canonicalWorkEventFixtures[0] };
    const required = [
      'source_runtime',
      'source_session_id',
      'raw_ref',
      'extractor_version',
      'confidence',
      'review_status',
      'occurred_at',
      'project_id',
    ] as const;
    for (const field of required) {
      const candidate = { ...base, [field]: undefined };
      expect(() => parseCanonicalWorkEvent(candidate)).toThrow();
      const result = canonicalWorkEventSchema.safeParse(candidate);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(String(result.error)).toContain(field);
      }
    }
  });

  it('drops undeclared fields on the consumer path', () => {
    const fixture = canonicalWorkEventFixtures[0];
    const withExtra = { ...fixture, unrecognized_extension: { future: true } };
    const parsed = parseCanonicalWorkEvent(withExtra);
    expect(parsed).toEqual(fixture);
    expect('unrecognized_extension' in parsed).toBe(false);
  });

  it('rejects undeclared fields on the producer path', () => {
    expect(() =>
      encodeCanonicalWorkEvent({ ...canonicalWorkEventFixtures[0], extra: 'no' }),
    ).toThrow();
  });

  it('rejects an unsupported schema_version explicitly', () => {
    const future = {
      ...canonicalWorkEventFixtures[0],
      schema_version: canonicalWorkEventSchemaVersion + 1,
    };
    let caught: unknown;
    try {
      parseCanonicalWorkEvent(future);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedWorkEventVersionError);
    if (caught instanceof UnsupportedWorkEventVersionError) {
      expect(caught.received).toBe(canonicalWorkEventSchemaVersion + 1);
      expect(caught.supported).toBe(canonicalWorkEventSchemaVersion);
    }
  });

  it('routes a malformed schema_version into the normal schema failure', () => {
    // The probe never swallows a bad type: full parsing names the field.
    expect(() =>
      parseCanonicalWorkEvent({ ...canonicalWorkEventFixtures[0], schema_version: 'one' }),
    ).toThrow();
    expect(() =>
      encodeCanonicalWorkEvent({ ...canonicalWorkEventFixtures[0], schema_version: 'one' }),
    ).toThrow();
  });

  it('refuses an unknown event_type at a supported version (fails closed)', () => {
    expect(() =>
      parseCanonicalWorkEvent({ ...canonicalWorkEventFixtures[0], event_type: 'work.alien' }),
    ).toThrow();
  });

  it('enforces the confidence band [0, 1]', () => {
    for (const confidence of [-0.01, 1.01]) {
      expect(() =>
        parseCanonicalWorkEvent({ ...canonicalWorkEventFixtures[0], confidence }),
      ).toThrow();
    }
    expect(
      parseCanonicalWorkEvent({ ...canonicalWorkEventFixtures[0], confidence: 1 }).confidence,
    ).toBe(1);
  });

  it('strict and tolerant parses agree on a clean event', () => {
    for (const fixture of canonicalWorkEventFixtures) {
      expect(canonicalWorkEventStrictSchema.parse(fixture)).toEqual(
        canonicalWorkEventSchema.parse(fixture),
      );
    }
  });
});

describe('session-internal events', () => {
  it('one fixture per session verb round-trips lossless', () => {
    const sessionFixtures = canonicalWorkEventFixtures.filter((f) =>
      ['user.message', 'agent.message', 'tool.call.requested', 'tool.call.result'].includes(
        f.event_type,
      ),
    );
    expect(sessionFixtures).toHaveLength(4);
    for (const fixture of sessionFixtures) {
      expect(parseCanonicalWorkEvent(fixture)).toEqual(fixture);
    }
  });

  it('the metadata class carries structural facts, never content', () => {
    const privacy = privacyOf(parseCanonicalWorkEvent(fixtureOfType('user.message')));
    expect(privacy).toHaveProperty('char_length');
    expect(privacy).toHaveProperty('sha256', PRIVACY_HASH);
    expect('body' in privacy).toBe(false);
    expect('text' in privacy).toBe(false);
    expect('content' in privacy).toBe(false);
  });

  it('a tool call records its tool name', () => {
    const parsed = parseCanonicalWorkEvent(fixtureOfType('tool.call.requested'));
    expect((parsed.payload as { tool_name: string }).tool_name).toBe('read_file');
  });

  it('a malformed privacy hash is rejected', () => {
    const fixture = fixtureOfType('agent.message');
    const malformed = {
      ...fixture,
      payload: { privacy: { char_length: 10, sha256: 'not-hex' } },
    };
    expect(() => parseCanonicalWorkEvent(malformed)).toThrow();
  });

  it('undeclared privacy fields are stripped on the consumer path', () => {
    const fixture = fixtureOfType('user.message');
    const withExtra = {
      ...fixture,
      payload: {
        privacy: { ...privacyOf(fixture), body: 'the actual message body' },
      },
    };
    expect('body' in privacyOf(parseCanonicalWorkEvent(withExtra))).toBe(false);
  });
});
