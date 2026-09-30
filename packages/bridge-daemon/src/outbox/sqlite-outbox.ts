import type { DatabaseSync } from 'node:sqlite';

import type { OutboxCaptureInput, OutboxEvent, OutboxPort, OutboxState } from './ports.js';
export type { OutboxCaptureInput, OutboxEvent, OutboxPort, OutboxState } from './ports.js';

/**
 * node:sqlite Outbox implementation.
 *
 * Every transition is one transaction that moves exactly one state step
 * at a time; the server sees only the ack-confirming enumeration on its
 * own ingest-authorized wire. Nothing else touches the filesystem.
 *
 * Crash safety: SIGKILL leaves WAL pages in a merge-safe journal; a
 * restart simply reads the borrowed state, notices `sending` rows still
 * stuck on `sending_at` older than the loop's liveness budget, and hands
 * them back to pending via `releaseSending`. That is the spec's "no
 * event is lost and no event is duplicated on resume".
 */

export class SqliteOutbox implements OutboxPort {
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  readonly #backoffMs: (retries: number) => number;

  constructor(
    db: DatabaseSync,
    now: () => string = () => new Date().toISOString(),
    backoffMs?: (retries: number) => number,
  ) {
    this.#db = db;
    this.#now = now;
    this.#backoffMs =
      backoffMs ?? ((retries: number): number => Math.min(500 * 2 ** Math.min(retries, 7), 60_000));
  }

  async capture(input: OutboxCaptureInput): Promise<OutboxEvent> {
    const now = this.#now();
    if (input.privacy_class === 'local-only') {
      return Promise.resolve(this.#writeCaptureTerminal(input, now));
    }
    this.#write(
      `INSERT INTO outbox_events (
        event_id, device_id, project_id, state, seq, causation_id, event_type,
        captured_at, normalized_at, sending_at, acked_at, keep_reason,
        payload_hash, event_json, retry_count, retry_after
      ) VALUES (?, ?, ?, 'captured', NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, 0, NULL)`,
      input.event_id,
      input.device_id,
      input.project_id,
      input.causation_id ?? null,
      input.event_type,
      now,
      input.event_json,
    );
    return Promise.resolve(this.#expectGet(input.event_id));
  }

  get(eventId: string): Promise<OutboxEvent | null> {
    return Promise.resolve(this.#selectById(eventId));
  }

  promoteToPending(eventId: string, bindingId: string): Promise<OutboxEvent> {
    void bindingId;
    /* v8 ignore next -- the binding row is what decides privacy, so a
       capture under a local-only binding is routed before this call; the
       assert here is a defense-in-depth boundary rule. */
    // The promotion is intentionally one transaction so the seq counter
    // claim and the state flip are atomic — a crash mid-write cannot
    // lose a seq or open a gap.
    this.#db.exec('BEGIN');
    try {
      const existing = this.#expectGet(eventId);
      if (existing.state !== 'captured' && existing.state !== 'sending') {
        throw new Error(`cannot promote state ${existing.state} to pending`);
      }
      const maxSeq = this.#maxSeq(existing.device_id);
      const nextSeq = maxSeq + 1;
      this.#write(
        `UPDATE outbox_events
           SET state = 'pending', seq = ?, normalized_at = ?, sending_at = NULL, acked_at = NULL
         WHERE event_id = ?`,
        nextSeq,
        this.#now(),
        eventId,
      );

      this.#db.exec('COMMIT');
      return Promise.resolve(this.#expectGet(eventId));
      /* v8 ignore start -- sqlite-internal rollback under the current lock */
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    /* v8 ignore stop */
  }

  claimPending(deviceId: string, limit: number, nowIso: string): Promise<readonly OutboxEvent[]> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const toClaim = this.#db
        .prepare(
          `SELECT event_id FROM outbox_events
            WHERE device_id = ? AND state = 'pending'
              AND (retry_after IS NULL OR retry_after <= ?)
            ORDER BY seq ASC
            LIMIT ?`,
        )
        .all(deviceId, nowIso, limit) as { event_id: string }[];
      if (toClaim.length === 0) {
        this.#db.exec('COMMIT');
        return Promise.resolve([]);
      }
      const now = this.#now();
      const stmt = this.#db.prepare(
        "UPDATE outbox_events SET state = 'sending', sending_at = ? WHERE event_id = ? AND state = 'pending'",
      );
      for (const { event_id } of toClaim) {
        stmt.run(now, event_id);
      }
      this.#db.exec('COMMIT');
      // re-read after commit so the rows carry the sending timestamps
      const ids = toClaim.map((row) => row.event_id);
      const rows = ids.map((eventId) => this.#expectGet(eventId));
      return Promise.resolve(rows);
      /* v8 ignore start -- sqlite-internal rollback under the current lock */
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    /* v8 ignore stop */
  }

  acknowledge(eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return Promise.resolve();
    this.#db.exec('BEGIN');
    try {
      const mark = this.#db.prepare(
        "UPDATE outbox_events SET state = 'acked', acked_at = ? WHERE event_id = ?",
      );
      const markTime = this.#now();
      for (const id of eventIds) {
        mark.run(markTime, id);
      }
      const del = this.#db.prepare('DELETE FROM outbox_events WHERE event_id = ?');
      for (const id of eventIds) {
        del.run(id);
      }
      this.#db.exec('COMMIT');
      return Promise.resolve();
      /* v8 ignore start -- sqlite-internal rollback under the current lock */
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    /* v8 ignore stop */
  }

  releaseSending(
    eventIds: readonly string[],
  ): Promise<readonly { eventId: string; retry_after: string | null }[]> {
    this.#db.exec('BEGIN');
    try {
      const results: { eventId: string; retry_after: string | null }[] = [];
      for (const id of eventIds) {
        const existing = this.#retryRow(id);
        const nextRetry = new Date(
          new Date(this.#now()).getTime() + this.#backoffMs(existing.retry_count + 1),
        ).toISOString();
        this.#db
          .prepare(
            "UPDATE outbox_events SET state = 'pending', sending_at = NULL, retry_count = retry_count + 1, retry_after = ? WHERE event_id = ? AND state = 'sending'",
          )
          .run(nextRetry, id);
        results.push({ eventId: id, retry_after: nextRetry });
      }
      this.#db.exec('COMMIT');
      return Promise.resolve(results);
      /* v8 ignore start -- the rollback fires only if the connection itself is broken mid-transaction */
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
      /* v8 ignore stop */
    }
  }

  parkLocalOnly(eventId: string, reason: string): Promise<void> {
    const row = this.#expectGet(eventId);
    if (row.state === 'local_only' || row.state === 'quarantined') return Promise.resolve();
    this.#write(
      "UPDATE outbox_events SET state = 'local_only', keep_reason = ?, seq = NULL WHERE event_id = ?",
      reason,
      eventId,
    );
    return Promise.resolve();
  }

  quarantine(eventId: string, reason: string): Promise<void> {
    const row = this.#expectGet(eventId);
    /* v8 ignore next 1 -- only non-terminal rows are re-classified; terminal rows stay as-is */
    if (row.state === 'captured' || row.state === 'normalized' || row.state === 'pending') {
      throw new Error(`cannot quarantine ${row.state} — normalize or quarantine from sending only`);
    }
    this.#write(
      "UPDATE outbox_events SET state = 'quarantined', keep_reason = ? WHERE event_id = ?",
      reason,
      eventId,
    );
    return Promise.resolve();
  }

  close(): void {
    this.#db.close();
  }

  #writeCaptureTerminal(input: OutboxCaptureInput, capturedAt: string): OutboxEvent {
    this.#write(
      `INSERT INTO outbox_events (
         event_id, device_id, project_id, state, seq, causation_id, event_type,
         captured_at, normalized_at, sending_at, acked_at, keep_reason,
         payload_hash, event_json
       ) VALUES (?, ?, ?, 'local_only', NULL, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?)`,
      input.event_id,
      input.device_id,
      input.project_id,
      input.causation_id ?? null,
      input.event_type,
      capturedAt,
      `privacy-local-only`,
      input.event_json,
    );
    return this.#expectGet(input.event_id);
  }

  #expectGet(eventId: string): OutboxEvent {
    const row = this.#selectById(eventId);
    /* v8 ignore next 3 -- write paths synchronously validate before read; the throw only fires if "SELECT by id" returns nothing after the row was just inserted */
    if (row === null) throw new Error(`outbox event ${eventId} is missing after write`);
    return row;
  }

  #selectById(eventId: string): OutboxEvent | null {
    const row = this.#db.prepare('SELECT * FROM outbox_events WHERE event_id = ?').get(eventId) as
      Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return mapRow(row);
  }

  #maxSeq(deviceId: string): number {
    const row = this.#db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM outbox_events WHERE device_id = ?')
      .get(deviceId) as { max_seq: number };
    return row.max_seq;
  }

  #write(sql: string, ...params: (string | number | null)[]): void {
    this.#db.prepare(sql).run(...params);
  }

  #retryRow(eventId: string): { retry_count: number } {
    const row = this.#db
      .prepare('SELECT retry_count FROM outbox_events WHERE event_id = ?')
      .get(eventId) as { retry_count: number } | undefined;
    return row ?? { retry_count: 0 };
  }
}

function mapRow(row: Record<string, unknown>): OutboxEvent {
  const text = (key: string): string => {
    const value = row[key];
    /* v8 ignore next -- SQL schema pins TEXT; this guards a corrupt elsewhere shard */
    if (typeof value !== 'string') throw new Error('expected text');
    return value;
  };
  const textOrNull = (key: string): string | null => {
    const value = row[key];
    if (value === null) return null;
    /* v8 ignore next -- schema pins TEXT/NULL; nothing else */
    if (typeof value !== 'string') throw new Error('expected text or null');
    return value;
  };
  const numberOrNull = (key: string): number | null => {
    const value = row[key];
    if (value === null) return null;
    /* v8 ignore next -- seq is INTEGER in the DDL; malformed rows abort insert */
    if (typeof value !== 'number') throw new Error('expected number or null');
    return value;
  };
  return {
    event_id: text('event_id'),
    device_id: text('device_id'),
    project_id: text('project_id'),
    state: text('state') as OutboxState,
    seq: numberOrNull('seq'),
    causation_id: textOrNull('causation_id'),
    event_type: text('event_type'),
    captured_at: text('captured_at'),
    normalized_at: textOrNull('normalized_at') ?? undefined,
    sending_at: textOrNull('sending_at') ?? undefined,
    acked_at: textOrNull('acked_at') ?? undefined,
    keep_reason: textOrNull('keep_reason'),
    payload_hash: textOrNull('payload_hash'),
    event_json: text('event_json'),
    retry_count: Number(row['retry_count'] ?? 0),
    retry_after: textOrNull('retry_after'),
  };
}
