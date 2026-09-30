/**
 * Project directory port — the read side of `search_projects` and the
 * authorization half of every protected query.
 *
 * Authorization is membership, not repository permissions (the "humans enact"
 * rule cannot live in repository permissions): a caller's device resolves to
 * a participant, and this port answers which projects that participant may
 * read. Deny is the default — the membership row is the only grant, and a
 * caller must not be able to distinguish "no such project" from "not your
 * project" (standard 04: authorization tests prove cross-scope isolation, not
 * only successful access).
 *
 * The port is deliberately small: search is a directory concern (titles,
 * statuses, state versions — all projection caches), not a domain concern.
 * The kernel never sees this port; the query use case composes it with the
 * event ledger.
 */

/** One project in a directory listing. Never carries membership of other participants. */
export interface ProjectSummary {
  readonly project_id: string;
  readonly title: string;
  readonly status: string;
  readonly state_version: number;
}

/** Cursor state for paginated directory search; opaque to the client. */
export interface ProjectDirectoryCursor {
  readonly title: string;
  readonly project_id: string;
}

/** A page of the directory search. */
export interface ProjectDirectoryPage {
  readonly results: readonly ProjectSummary[];
  readonly has_more: boolean;
  readonly next_cursor: ProjectDirectoryCursor | null;
}

/**
 * Answers the projects a participant may read, filtered by a title prefix.
 * The membership filter is applied server-side, never client-side; a
 * non-member sees nothing, including the existence of the project.
 */
export interface ProjectDirectory {
  /**
   * Lists projects whose title starts with `query` (case-insensitive,
   * anchored) that `participantId` is a member of. Page order is stable
   * (title, then id) so cursors never overlap.
   */
  search(
    participantId: string,
    query: string,
    limit: number,
    cursor: ProjectDirectoryCursor | null,
  ): Promise<ProjectDirectoryPage>;

  /**
   * Membership gate for a single project: true only when the participant is
   * an active member. This is the deny-default check every protected query
   * route runs before touching the ledger.
   */
  isMember(participantId: string, projectId: string): Promise<boolean>;
}
