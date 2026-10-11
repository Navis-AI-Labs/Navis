import { parseIngestReceipt } from '@navis/contracts';
import type { OutboxPort } from '../outbox/ports.js';

/** Advances one upload batch; the caller schedules the next attempt and owns crash recovery. */
import type { OutboxEvent } from '../outbox/ports.js';

export interface HttpResponseLike {
  readonly status: number;
  readonly body: string;
  readonly retryAfter?: string;
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
interface ParsedReply {
  readonly acked: readonly string[];
  readonly rejected: readonly { eventId: string; reason: string }[];
  readonly transport: boolean;
}

function parseReply(body: string, batch: readonly OutboxEvent[]): ParsedReply {
  try {
    const envelope = JSON.parse(body) as { data?: unknown };
    const parsed = parseIngestReceipt(envelope.data, batch.length);
    const results = parsed.event_results;
    const acked: string[] = [];
    const rejected: { eventId: string; reason: string }[] = [];
    for (const result of results) {
      const event = batch[result.index];
      /* v8 ignore next 1 -- parseIngestReceipt already verified every index against this batch length */
      if (event === undefined) throw new Error('receipt outside batch');
      if (result.outcome === 'rejected') {
        rejected.push({ eventId: event.event_id, reason: result.rejection.token });
      } else acked.push(event.event_id);
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

  const retry = async (error?: string, notBefore?: string): Promise<UploadLoopSlice> => {
    const released = await outbox.releaseSending(
      claimed.map((row) => row.event_id),
      notBefore,
    );
    const retried = released.map((row) => ({
      eventIds: [row.eventId],
      nextRetryAfter: row.retry_after ?? nowIso,
    }));
    return {
      claimed,
      ackedCount: 0,
      retried,
      nextTickAt: retried.map((row) => row.nextRetryAfter).sort()[0] ?? nowIso,
      ...(error === undefined ? {} : { error }),
    };
  };
  let response: HttpResponseLike;
  try {
    response = await sender.send(claimed);
  } catch (error) {
    return retry(error instanceof Error ? error.message : undefined);
  }
  // Transport refusals retain every row; only validated per-event rejections quarantine.
  if (response.status < 200 || response.status >= 300)
    return retry(`http_${String(response.status)}`, response.retryAfter);
  const reply = parseReply(response.body, claimed);
  if (reply.transport) return retry();
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
