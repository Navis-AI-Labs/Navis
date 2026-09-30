import type {
  ProjectDirectory,
  ProjectDirectoryCursor,
  ProjectDirectoryPage,
  ProjectSummary,
} from '@navis/domain';
import type postgres from 'postgres';

/**
 * Postgres ProjectDirectory. The membership filter is a join, never a
 * client-side filter: the query shape itself enforces deny-default. A
 * non-member sees neither the row nor its existence.
 *
 * Page order is (title, project_id) — stable and total — so a cursor is an
 * exclusive pair: the next page reads strictly after it, which makes overlap
 * impossible regardless of concurrent inserts (a new project sorts before the
 * cursor only if it would have appeared on an earlier page, which the caller
 * has already consumed; it surfaces on a later page only if the caller
 * re-queries from the start).
 */
export class PostgresProjectDirectory implements ProjectDirectory {
  constructor(private readonly sql: postgres.Sql) {}

  async search(
    participantId: string,
    query: string,
    limit: number,
    cursor: ProjectDirectoryCursor | null,
  ): Promise<ProjectDirectoryPage> {
    // anchored, case-insensitive prefix; LIKE with an ESCAPE-free pattern
    // because the query is a label validated by the contract schema
    const pattern = query.toLowerCase() + '%';
    const rows = await this.sql`
      SELECT p.id AS project_id, p.title, p.status, p.current_state_version
      FROM projects p
      JOIN project_members m
        ON m.project_id = p.id AND m.participant_id = ${participantId}
      WHERE m.deleted_at IS NULL
        AND p.deleted_at IS NULL
        AND lower(p.title) LIKE ${pattern}
        ${cursor ? this.sql`AND (p.title, p.id) > (${cursor.title}, ${cursor.project_id})` : this.sql``}
      ORDER BY p.title ASC, p.id ASC
      LIMIT ${limit + 1}
    `;
    const visible = rows.map((row) => this.toSummary(row as Record<string, unknown>));
    const hasMore = visible.length > limit;
    const page = hasMore ? visible.slice(0, limit) : visible;
    const last = page[page.length - 1];
    const next: ProjectDirectoryCursor | null =
      hasMore && last !== undefined ? { title: last.title, project_id: last.project_id } : null;
    return { results: page, has_more: hasMore, next_cursor: next };
  }

  async isMember(participantId: string, projectId: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT 1 FROM project_members
      WHERE participant_id = ${participantId}
        AND project_id = ${projectId}
        AND deleted_at IS NULL
    `;
    return rows.length > 0;
  }

  private toSummary(row: Record<string, unknown>): ProjectSummary {
    return {
      project_id: String(row['id']),
      title: String(row['title']),
      status: String(row['status']),
      state_version: Number(row['current_state_version']),
    };
  }
}
