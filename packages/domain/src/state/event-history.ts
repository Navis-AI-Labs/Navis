import { deepFreeze } from './canonical.js';
import { stateEventSchema, type StateEvent } from './events.js';

/**
 * Event history — the append-only, deep-frozen in-memory ledger the kernel
 * builds on. This type is the storage-independent half of task 4.1: it
 * validates each event against the StateEvent schema, validates seq
 * contiguity (each seq is exactly head+1), deep-freezes on append, and
 * offers NO update or delete path (spec: no API may offer update or delete
 * on appended events).
 *
 * Sequencing and state_version assignment belong to the kernel (task 4.2);
 * this type only refuses events that do not continue the sequence.
 */

export class EventHistory {
  private readonly events: StateEvent[] = [];
  private readonly bySeq = new Map<number, StateEvent>();

  /** Number of appended events. */
  get size(): number {
    return this.events.length;
  }

  /** The last appended event, or undefined when empty. */
  get head(): StateEvent | undefined {
    return this.events[this.events.length - 1];
  }

  /** The current head seq (0 when empty) — the next event must carry head+1. */
  get currentSeq(): number {
    return this.head?.seq ?? 0;
  }

  /**
   * Appends one event: schema-validated, seq must continue the head
   * (1-based, gapless), then deep-frozen. All-or-nothing per event.
   */
  append(event: StateEvent): StateEvent {
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
    const frozen = deepFreeze(parsed.data);
    this.events.push(frozen);
    this.bySeq.set(frozen.seq, frozen);
    return frozen;
  }

  /** Reads events from a seq cursor (inclusive), in seq order. */
  load(fromSeq: number): readonly StateEvent[] {
    const cursor = Math.max(1, Math.floor(fromSeq));
    return this.events.filter((e) => e.seq >= cursor);
  }

  /** Read-only view of the full history (spec: append-only surface). */
  all(): readonly StateEvent[] {
    return this.events;
  }

  /**
   * Tamper probe: re-verifies every stored event's schema, seq contiguity,
   * and freeze status. Returns the offending seq on any violation.
   */
  verifyIntegrity(): { ok: true } | { ok: false; atSeq: number; reason: string } {
    let expected = 0;
    for (const e of this.events) {
      if (!stateEventSchema.safeParse(e).success || e.seq !== expected + 1) {
        return { ok: false, atSeq: e.seq, reason: 'schema or seq violation' };
      }
      if (!Object.isFrozen(e)) {
        return { ok: false, atSeq: e.seq, reason: 'stored event is not frozen' };
      }
      expected = e.seq;
    }
    return { ok: true };
  }
}
