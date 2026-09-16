import { z } from 'zod';

/*
 * Wire primitives for the business contracts in this package. The public
 * schemas re-declare what their concepts need (ADR-0001: contracts never
 * import server implementation); the domain schema layer is an independent
 * authority for the concepts the kernel owns. These primitives exist to
 * keep each module's re-declarations byte-identical.
 */

/** UUID reference string (RFC 9562 layout); version-agnostic — the listener decides semantics. */
export const uuidRefSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** Millisecond-precision ISO 8601 instant carried on public contracts. */
export const instantWireSchema = z.iso.datetime({ precision: 3 });

/** Free text on a public contract: non-empty, bounded. */
export const textWireSchema = z.string().min(1).max(65_536);

/** Short label on a public contract (runtime name, extractor version, ...). */
export const labelWireSchema = z.string().min(1).max(128);

/** Bounded non-negative project state version reference. */
export const stateVersionWireSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
