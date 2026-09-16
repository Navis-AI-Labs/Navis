import type postgres from 'postgres';

import { inboxErrors } from '@navis/domain';
import type { BeginResult, CommandInbox, CommandOutcome } from '@navis/domain';

interface InboxRow {
  readonly command_type: string;
  readonly payload_hash: string;
  readonly status: 'received' | 'applied' | 'failed';
  readonly result_ref: string | null;
}

function outcomeFrom(row: InboxRow): CommandOutcome | undefined {
  if (row.status === 'received') return undefined;
  const result = row.result_ref;
  if (result === null) throw new Error('terminal claim without a stored outcome');
  return row.status === 'applied' ? { status: 'applied', result } : { status: 'failed', result };
}

/**
 * Postgres CommandInbox. The UNIQUE(project_id, idempotency_key) constraint
 * arbitrates racing claims: exactly one INSERT wins, the loser reads the
 * row and classifies against it — one fresh winner per key, everywhere.
 * The table predates this change; this class only gives it behavior.
 */
export class PostgresCommandInbox implements CommandInbox {
  private readonly sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  async begin(
    projectId: string,
    key: string,
    commandType: string,
    payloadHash: string,
  ): Promise<BeginResult> {
    const inserted = await this.sql<{ status: 'received' }[]>`
      INSERT INTO command_inbox (project_id, idempotency_key, command_type, payload_hash, status, created_at)
      VALUES (${projectId}, ${key}, ${commandType}, ${payloadHash}, 'received', now())
      ON CONFLICT (project_id, idempotency_key) DO NOTHING
      RETURNING status
    `;
    if (inserted.length === 1) return { status: 'fresh' };
    return this.classifyExisting(projectId, key, commandType, payloadHash);
  }

  private async classifyExisting(
    projectId: string,
    key: string,
    commandType: string,
    payloadHash: string,
  ): Promise<BeginResult> {
    const rows = await this.sql<InboxRow[]>`
      SELECT command_type, payload_hash, status, result_ref
      FROM command_inbox
      WHERE project_id = ${projectId} AND idempotency_key = ${key}
    `;
    const row = rows[0];
    if (row === undefined)
      throw new Error('command inbox row vanished between insert conflict and read');
    if (row.payload_hash !== payloadHash || row.command_type !== commandType) {
      throw inboxErrors.collision();
    }
    const outcome = outcomeFrom(row);
    if (outcome === undefined) return { status: 'processing' };
    return { status: 'replay', outcome };
  }

  async complete(projectId: string, key: string, outcome: CommandOutcome): Promise<void> {
    // Only a received claim may transition terminal: the WHERE predicate is
    // the guard, so an already-completed claim cannot be overwritten.
    const updated = await this.sql<{ status: string }[]>`
      UPDATE command_inbox
      SET status = ${outcome.status}, result_ref = ${outcome.result}
      WHERE project_id = ${projectId} AND idempotency_key = ${key} AND status = 'received'
      RETURNING status
    `;
    if (updated.length > 0) return;
    const rows = await this.sql<{ status: string }[]>`
      SELECT status FROM command_inbox
      WHERE project_id = ${projectId} AND idempotency_key = ${key}
    `;
    if (rows.length === 0) throw inboxErrors.unknownKey();
    throw inboxErrors.collision();
  }
}
