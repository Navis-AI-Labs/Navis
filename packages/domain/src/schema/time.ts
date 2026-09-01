import { z } from 'zod';

/**
 * The one legal shape of time in the system: a millisecond-precision, UTC-only
 * ISO 8601 instant with a literal Z suffix, in extended format.
 *
 * Uses the schema library's native ISO datetime validator instead of a
 * hand-rolled regex, so real calendar rules are enforced (month 1-12, real
 * day-of-month, leap years) rather than just the character layout. The fixed
 * millisecond precision and UTC-only suffix keep values lexically and
 * chronologically sortable and make stored strings byte-comparable across
 * systems.
 */

export const instantSchema = z.iso.datetime({ precision: 3 }).meta({
  description: 'Millisecond-precision UTC instant (ISO 8601, extended format, Z suffix).',
  id: 'Instant',
});
