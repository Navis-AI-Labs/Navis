/**
 * Canonical JSON: the single serializer used for replay-equality comparison
 * and tamper detection.
 *
 * Rules: object keys are sorted recursively, so two structurally identical
 * values always serialize byte-identically regardless of insertion order;
 * `undefined` is dropped (JSON.stringify semantics); functions and symbols
 * are dropped by JSON.stringify — a projection must not contain them, and
 * the parser below makes that a hard failure rather than silent data loss.
 */

/** Serializes a value to canonical JSON (recursively sorted object keys). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/**
 * Parses canonical JSON back to a value with the same strictness the
 * serializer applied: NaN/Infinity and bare functions throw — a value that
 * cannot round-trip is a contract breach, not silently coerced data.
 */
export function parseCanonicalJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('canonical JSON cannot carry non-finite numbers');
    }
    return value;
  });
}

/** Structural equality under the canonical form: same canonical JSON. */
export function canonicalEquals(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

/**
 * Deep-freezes a value in place (objects, arrays, and functions), the way
 * Object.freeze would but through every nesting level. Cycles throw — a
 * frozen event graph must be a tree, and JSON data cannot carry cycles.
 */
export function deepFreeze<T>(value: T): T {
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (node === null || (typeof node !== 'object' && typeof node !== 'function')) return;
    if (seen.has(node)) throw new Error('cannot deep-freeze a cyclic structure');
    seen.add(node);
    Object.freeze(node);
    for (const key of Object.getOwnPropertyNames(node)) {
      walk((node as Record<string, unknown>)[key]);
    }
  };
  walk(value);
  return value;
}
