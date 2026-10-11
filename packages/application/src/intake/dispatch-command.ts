import { canonicalJson, hashCommandPayload } from '@navis/domain';
import type { CommandInbox, CommandOutcome } from '@navis/domain';

/**
 * Idempotent command intake use case. Wraps a caller-supplied executor with
 * exactly-once submission semantics: the first submission executes and its
 * outcome is stored; every identical resubmission replays that stored
 * outcome without re-invoking the executor; a submission missing its
 * idempotency key refuses before anything else happens.
 *
 * The caller owns command mapping and supplies the transaction-bound inbox
 * and executor. Durable project operations must commit the inbox outcome
 * and ledger writes in the same transaction.
 */

/** Maximum canonical-JSON size of a storable outcome; larger submissions fail loudly. */
const OUTCOME_SIZE_BUDGET = 65_536;

export interface DispatchRequest {
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly payload: unknown;
}

/** Thrown errors require caller-owned rollback; a nontransactional inbox retains its claim. */
export type CommandExecutor = (payload: unknown) => Promise<DispatchResultValue>;

export type DispatchResultValue =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

export type DispatchResponse =
  | { readonly status: 'applied'; readonly result: DispatchResultValue; readonly replayed: boolean }
  | { readonly status: 'failed'; readonly result: DispatchResultValue; readonly replayed: boolean }
  | { readonly status: 'in_flight' };

export async function dispatchCommand(
  inbox: CommandInbox,
  request: DispatchRequest,
  execute: CommandExecutor,
): Promise<DispatchResponse> {
  if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.trim().length === 0) {
    throw new Error('idempotency-key-required');
  }
  const payloadHash = hashCommandPayload(request.payload);
  const begin = await inbox.begin(
    request.projectId,
    request.idempotencyKey,
    request.commandType,
    payloadHash,
  );
  if (begin.status === 'replay') {
    return {
      status: begin.outcome.status,
      result: JSON.parse(begin.outcome.result) as DispatchResultValue,
      replayed: true,
    };
  }
  if (begin.status === 'processing') return { status: 'in_flight' };

  const result = await execute(request.payload);
  const text = canonicalJson(result);
  if (text.length > OUTCOME_SIZE_BUDGET) {
    /* Oversized outcomes are never stored verbatim; the claim becomes
     * terminal-failed with a deterministic small marker so a retry replays
     * the refusal, and the caller still sees the failure immediately. */
    const failure: DispatchResultValue = {
      ok: false,
      error: 'command-outcome-exceeds-intake-budget',
    };
    await inbox.complete(request.projectId, request.idempotencyKey, {
      status: 'failed',
      result: canonicalJson(failure),
    });
    throw new Error('command-outcome-exceeds-intake-budget');
  }
  const stored: CommandOutcome = { status: result.ok ? 'applied' : 'failed', result: text };
  await inbox.complete(request.projectId, request.idempotencyKey, stored);
  return { status: stored.status, result, replayed: false };
}
