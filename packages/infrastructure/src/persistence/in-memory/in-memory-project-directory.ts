import type {
  ProjectDirectory,
  ProjectDirectoryCursor,
  ProjectDirectoryPage,
  ProjectSummary,
} from '@navis/domain';

/**
 * In-memory ProjectDirectory: the semantic definition of the port. The
 * membership set is the only grant; search and the single-project gate read
 * the same rows so a non-member cannot distinguish "absent" from "denied".
 */
export class InMemoryProjectDirectory implements ProjectDirectory {
  private readonly projects = new Map<string, ProjectSummary>();
  private readonly members = new Set<string>();

  /** Test seam: registers a project the directory serves. */
  register(project: ProjectSummary): void {
    this.projects.set(project.project_id, project);
  }

  /** Test seam: grants participant membership; the only way to make a project visible. */
  grant(participantId: string, projectId: string): void {
    this.members.add(participantId + '|' + projectId);
  }

  async search(
    participantId: string,
    query: string,
    limit: number,
    cursor: ProjectDirectoryCursor | null,
  ): Promise<ProjectDirectoryPage> {
    // Promise.resolve keeps the async port contract under the require-await rule
    return Promise.resolve(this.computePage(participantId, query, limit, cursor));
  }

  private computePage(
    participantId: string,
    query: string,
    limit: number,
    cursor: ProjectDirectoryCursor | null,
  ): ProjectDirectoryPage {
    const prefix = query.toLowerCase();
    const visible = [...this.projects.values()]
      .filter((p) => this.members.has(participantId + '|' + p.project_id))
      .filter((p) => p.title.toLowerCase().startsWith(prefix))
      .filter((p) => {
        if (cursor === null) return true;
        // cursor is exclusive: strictly after (title, id) in the page order
        if (p.title === cursor.title) return p.project_id > cursor.project_id;
        return p.title > cursor.title;
      })
      .sort((a, b) =>
        a.title === b.title ? (a.project_id < b.project_id ? -1 : 1) : a.title < b.title ? -1 : 1,
      );
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    const last = page[page.length - 1];
    const next: ProjectDirectoryCursor | null =
      hasMore && last !== undefined ? { title: last.title, project_id: last.project_id } : null;
    return { results: page, has_more: hasMore, next_cursor: next };
  }

  async isMember(participantId: string, projectId: string): Promise<boolean> {
    // Promise.resolve keeps the async port contract under the require-await rule
    return Promise.resolve(this.members.has(participantId + '|' + projectId));
  }
}
