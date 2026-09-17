import type postgres from 'postgres';

import {
  dispatchCommand,
  type DispatchRequest,
  type DispatchResponse,
  type DispatchResultValue,
} from '@navis/application';
import { PostgresCommandInbox } from './postgres-command-inbox.js';

/**
 * Transaction-bound intake composition (Postgres-only).
 *
 * Runs the whole intake flow inside ONE database transaction: the claim
 * insert, the executor's writes, and the terminal complete are a single
 * commit unit. If the executor throws or the transaction aborts, everything
 * rolls back — no orphaned received claim, no partial outcome — and a retry
 * with the same key begins fresh. The supplied executor MUST route every
 * ledger write through adapters bound to the transaction handle it is
 * given; writes issued through non-transaction connections escape the
 * guarantee by construction. The in-memory adapter is deliberately out of
 * scope (R0 has no transactions there).
 */
export interface PostgresCommandIntakeTx {
  dispatch(
    request: DispatchRequest,
    execute: (sql: postgres.TransactionSql, payload: unknown) => Promise<DispatchResultValue>,
  ): Promise<DispatchResponse>;
}

export function createPostgresCommandIntake(sql: postgres.Sql): PostgresCommandIntakeTx {
  return {
    dispatch(request, execute) {
      return sql.begin(async (tx) => {
        const inbox = new PostgresCommandInbox(tx);
        return dispatchCommand(inbox, request, (payload: unknown) => execute(tx, payload));
      });
    },
  };
}
