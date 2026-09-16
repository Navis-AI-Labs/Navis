import { describe, expect, it } from 'vitest';

import {
  UnsupportedWorkEventVersionError,
  canonicalWorkEventSchema,
  canonicalWorkEventSchemaVersion,
  canonicalWorkEventStrictSchema,
  canonicalWorkEventTypeSchema,
  encodeCanonicalWorkEvent,
  parseCanonicalWorkEvent,
} from '../src/work-event.js';
import { canonicalWorkEventFixtures } from './work-event.fixtures.js';

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
