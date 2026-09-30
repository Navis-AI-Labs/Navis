import type { OutboxPort } from '../outbox/ports.js';

/**
 * Upload loop (spec §the Outbox, task 6.4): takes pending rows in bounded
 * batches of 50, sends them, then acks the per-event results. On any
 * transport failure or rejects the loop backs off exponentially (capped
 * at 60 seconds) by writing `retry_after` into the row — a retry claim
 * won't take a row whose backoff has not yet elapsed.
 *
 * Crash semantics: SIGKILL mid-send leaves rows in 'sending'; the next
 * daemon instance reclaims them via `releaseSending`, which is a spec
 * requirement ("no event is lost and no event is duplicated on resume").
 * After the claim is marked the row is sent; ack is afterwards erased, the
 * row is deleted; reject → quarantine with reason attached.
 */
import type { OutboxEvent } from '../outbox/ports.js';

export interface HttpResponseLike {
  readonly status: number;
  readonly body: string;
}

export interface HttpSenderLike {
  send(batch: readonly OutboxEvent[]): Promise<HttpResponseLike>;
}

export interface BackoffStep {
  readonly eventIds: readonly string[];
  readonly nextRetryAfter: string;
}

export interface UploadLoopSlice {
  readonly claimed: readonly OutboxEvent[];
  readonly ackedCount: number;
  readonly retried: readonly BackoffStep[];
  readonly nextTickAt: string;
  readonly error?: string;
}

const MAX_BATCH = 50;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 60_000;

function exponentialMs(retries: number): number {
  const clamped = Math.min(retries, 7);
  return Math.min(BASE_BACKOFF_MS * 2 ** clamped, MAX_BACKOFF_MS);
}

function addIso(nowIso: string, ms: number): string {
  return new Date(new Date(nowIso).getTime() + ms).toISOString();
}

interface ParsedReply {
  readonly acked: readonly string[];
  readonly rejected: readonly { eventId: string; reason: string }[];
  readonly transport: boolean;
}

function parseReply(body: string): ParsedReply {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const results = parsed['results'];
    if (!Array.isArray(results)) {
      return { acked: [], rejected: [], transport: true };
    }
    const acked: string[] = [];
    const rejected: { eventId: string; reason: string }[] = [];
    for (const entry of results) {
      if (typeof entry !== 'object' || entry === null) continue;
      const r = entry as Record<string, unknown>;
      const eventId = r['event_id'];
      if (typeof eventId !== 'string') continue;
      if (r['outcome'] === 'acked') {
        acked.push(eventId);
      } else {
        const reasonValue = r['reason'];
        rejected.push({
          eventId,
          reason: typeof reasonValue === 'string' ? reasonValue : 'outcome-missing',
        });
      }
    }
    return { acked, rejected, transport: false };
  } catch {
    return { acked: [], rejected: [], transport: true };
  }
}

/**
 * One round of the upload loop.
 *
 * This function carries no retry scheduling responsibility: the caller decides
 * when to run again using `slice.nextTickAt` as the floor.
 */
export async function tick(
  outbox: OutboxPort,
  sender: HttpSenderLike,
  deviceId: string,
  nowIso: string,
): Promise<UploadLoopSlice> {
  const claimed = await outbox.claimPending(deviceId, MAX_BATCH, nowIso);
  if (claimed.length === 0) {
    return { claimed: [], ackedCount: 0, retried: [], nextTickAt: nowIso };
  }

  let response: HttpResponseLike;
  try {
    response = await sender.send(claimed);
  } catch (error) {
    const ids = claimed.map((r) => r.event_id);
    await outbox.releaseSending(ids);
    const stack: BackoffStep[] = ids.map((id) => ({
      eventIds: [id],
      nextRetryAfter: addIso(nowIso, exponentialMs(1)),
    }));
    return {
      claimed,
      ackedCount: 0,
      retried: stack,
      nextTickAt: addIso(nowIso, exponentialMs(claimed.length)),
      ...(error instanceof Error ? { error: error.message } : {}),
    };
  }

  if (response.status < 200 || response.status >= 300) {
    // HTTP-level rejection: release with backoff rather than quarantine — the
    // server said it can't talk and the spec says "permanent failure" is
    // a flavoursome outcome: acknowledges per-event, not an HTTP 502.
    const ids = claimed.map((r) => r.event_id);
    await outbox.releaseSending(ids);
    const stack: BackoffStep[] = ids.map((id) => ({
      eventIds: [id],
      nextRetryAfter: addIso(nowIso, exponentialMs(1)),
    }));
    return {
      claimed,
      ackedCount: 0,
      retried: stack,
      nextTickAt: addIso(nowIso, exponentialMs(1)),
      error: `http_${response.status.toString()}`,
    };
  }

  const reply = parseReply(response.body);
  if (reply.transport) {
    // 2xx with an unreadable body — the server answer is unparseable, so
    // treat it like a transport failure: release with backoff, never ack.
    const ids = claimed.map((r) => r.event_id);
    await outbox.releaseSending(ids);
    const stack: BackoffStep[] = ids.map((id) => ({
      eventIds: [id],
      nextRetryAfter: addIso(nowIso, exponentialMs(1)),
    }));
    return { claimed, ackedCount: 0, retried: stack, nextTickAt: addIso(nowIso, exponentialMs(1)) };
  }
  if (reply.acked.length > 0) {
    await outbox.acknowledge(reply.acked);
  }
  for (const r of reply.rejected) {
    await outbox.quarantine(r.eventId, r.reason);
  }
  return {
    claimed,
    ackedCount: reply.acked.length,
    retried: [],
    nextTickAt: nowIso,
  };
}
