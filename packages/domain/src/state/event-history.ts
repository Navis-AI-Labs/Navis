import { immutableCopy } from './canonical.js';
import { stateEventSchema, type StateEvent } from './events.js';

/** Validates an event sequence before replay or when checking a stored history. */
export function verifyEventHistory(
  events: readonly StateEvent[],
): { ok: true } | { ok: false; atSeq: number; reason: string } {
  let expected = 0;
  for (const event of events) {
    if (!stateEventSchema.safeParse(event).success || event.seq !== expected + 1) {
      return { ok: false, atSeq: event.seq, reason: 'schema or seq violation' };
    }
    expected = event.seq;
  }
  return { ok: true };
}

/**
 * Owns immutable event records and requires a contiguous sequence.
 * Sequence and business-version assignment belong to the kernel.
 */

export class EventHistory {
  readonly #events: StateEvent[] = [];

  /** Number of appended events. */
  get size(): number {
    return this.#events.length;
  }

  /** The last appended event, or undefined when empty. */
  get head(): StateEvent | undefined {
    return this.#events[this.#events.length - 1];
  }

  /** The current head seq (0 when empty) — the next event must carry head+1. */
  get currentSeq(): number {
    return this.head?.seq ?? 0;
  }

  /**
   * Appends one event: schema-validated, seq must continue the head
   * (1-based, gapless), then deep-frozen. All-or-nothing per event.
   */
  append(event: unknown): StateEvent {
    const parsed = stateEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(`invalid event: ${parsed.error.issues[0]?.message ?? 'schema violation'}`);
    }
    const expected = this.currentSeq + 1;
    if (parsed.data.seq !== expected) {
      throw new Error(
        `version-conflict: event seq ${String(parsed.data.seq)} does not continue head ${String(this.currentSeq)}`,
      );
    }
    const frozen = immutableCopy(parsed.data);
    this.#events.push(frozen);
    return frozen;
  }

  /** Reads events from a seq cursor (inclusive), in seq order. */
  load(fromSeq: number): readonly StateEvent[] {
    const cursor = Math.max(1, Math.floor(fromSeq));
    return Object.freeze(this.#events.filter((e) => e.seq >= cursor));
  }

  /** Immutable view of the full history. */
  all(): readonly StateEvent[] {
    return Object.freeze([...this.#events]);
  }

  /**
   * Re-verifies schema and sequence continuity. Stored records and the
   * collection are protected by ownership and immutable public views.
   */
  verifyIntegrity(): { ok: true } | { ok: false; atSeq: number; reason: string } {
    return verifyEventHistory(this.#events);
  }
}
