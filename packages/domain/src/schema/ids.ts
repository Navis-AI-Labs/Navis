import { webcrypto } from 'node:crypto';

import { z } from 'zod';

/**
 * UUIDv7 identifiers (RFC 9562 §5.7): unix_ts_ms(48) | ver(4) | rand_a(12) | var(2) | rand_b(62).
 *
 * The closure-scoped counter keeps generated ids monotonic through burst
 * generation, backwards clock steps, and per-millisecond overflow (§6.2).
 */

/** RFC 9562 variant bits (10xx). */
const VARIANT = 0b10;

/** RFC 9562 version nibble for v7. */
const VERSION = 0b0111;

export function createUuidv7(now: () => number = Date.now): () => string {
  let lastTimestampMs = -1;
  let counter = 0;
  return (): string => {
    const raw = now();
    let timestampMs = raw > lastTimestampMs ? raw : lastTimestampMs;
    if (timestampMs > lastTimestampMs) {
      const seed = new Uint8Array(2);
      webcrypto.getRandomValues(seed);
      counter = new DataView(seed.buffer).getUint16(0) & 0xfff;
      lastTimestampMs = timestampMs;
    } else {
      counter = (counter + 1) & 0xfff;
      if (counter === 0) {
        timestampMs += 1;
        lastTimestampMs = timestampMs;
      }
    }

    const bytes = new Uint8Array(16);
    webcrypto.getRandomValues(bytes);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, Math.floor(timestampMs / 2 ** 16)); // ts bits 47..16
    view.setUint16(4, timestampMs & 0xffff); // ts bits 15..0
    view.setUint8(6, (VERSION << 4) | (counter >> 8)); // ver | counter bits 11..8
    view.setUint8(7, counter & 0xff); // counter bits 7..0
    view.setUint8(8, (VARIANT << 6) | (view.getUint8(8) & 0x3f));
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/** Process-wide default generator (real clock). */
export const uuidv7: () => string = createUuidv7();

export const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .meta({ description: 'UUID string (RFC 9562).', id: 'Uuid' });

/** Full RFC 9562 check: version nibble AND variant bits (10xx), not just the hex layout. */
export const uuidv7Schema = uuidSchema
  .refine((value) => value[14] === '7', { message: 'not a UUIDv7' })
  .refine(
    (value) => {
      // variant bits are the two leading bits of the 17th hex digit's byte: '8'-'b'
      const variantChar = value[19];
      if (variantChar === undefined) return false;
      const variantNibble = Number.parseInt(variantChar, 16);
      return variantNibble >= 8 && variantNibble <= 11;
    },
    { message: 'not an RFC 9562 variant' },
  )
  .meta({ description: 'UUIDv7 string (time-ordered, RFC 9562 §5.7).', id: 'Uuidv7' });

/**
 * External system reference: an opaque string carried verbatim from an
 * external system. Navis-owned ids are UUIDv7; external ids never masquerade
 * as Navis-owned uuids.
 */
export const externalRefSchema = z
  .string()
  .min(1)
  .max(512)
  .meta({ description: 'Opaque external system reference.', id: 'ExternalRef' });

/** Recovers the unix-millisecond timestamp embedded in a UUIDv7; null if not v7. */
export function uuidv7Timestamp(value: string): number | null {
  if (!uuidv7Schema.safeParse(value).success) return null;
  const hex = value.replaceAll('-', '');
  // The schema guarantees hex layout, so parseInt cannot yield NaN here.
  return Number.parseInt(hex.slice(0, 8), 16) * 2 ** 16 + Number.parseInt(hex.slice(8, 12), 16);
}
