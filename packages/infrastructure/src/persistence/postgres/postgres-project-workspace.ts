import type postgres from 'postgres';
import { capabilitiesSchema } from '@navis/domain';
import type { ProjectWorkspace, ProjectTransaction, InstancePrincipal } from '@navis/application';
import { LOCAL_LEDGER_BYTES, PostgresEventStore } from './postgres-event-store.js';
import { PostgresCommandInbox } from './postgres-command-inbox.js';
import { PostgresDeviceAuth } from './postgres-device-auth.js';

/** All project writes, capability checks and intake claims share this transaction. */
export class PostgresProjectWorkspace implements ProjectWorkspace {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly maxLedgerBytes = LOCAL_LEDGER_BYTES,
  ) {}

  async transaction<T>(
    scope: string,
    operation: (tx: ProjectTransaction) => Promise<T>,
  ): Promise<T> {
    const result = await this.sql.begin(async (sql) => {
      await sql`SELECT set_config('statement_timeout', '15000', true), set_config('lock_timeout', '5000', true)`;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`;
      const context: ProjectTransaction = {
        events: new PostgresEventStore(sql, true, this.maxLedgerBytes),
        inbox: new PostgresCommandInbox(sql),
        devices: new PostgresDeviceAuth(sql),
        async principal(id) {
          const [row] =
            await sql`SELECT id, kind, display_name FROM instance_principals WHERE id=${id} AND disabled_at IS NULL`;
          if (row === undefined) return null;
          return {
            id: String(row['id']),
            kind: row['kind'] as InstancePrincipal['kind'],
            name: String(row['display_name']),
          };
        },
        async putPrincipal(principal, at) {
          await sql`INSERT INTO instance_principals (id,kind,display_name,created_at) VALUES (${principal.id},${principal.kind},${principal.name},${at})`;
        },
        async membership(projectId, participantId) {
          const [row] =
            await sql`SELECT is_owner, allowed_proposals, allowed_executions FROM project_members WHERE project_id=${projectId} AND participant_id=${participantId} AND deleted_at IS NULL`;
          if (row === undefined) return null;
          return {
            owner: row['is_owner'] === true,
            ...capabilitiesSchema.parse({
              allowed_proposals: row['allowed_proposals'] as unknown,
              allowed_executions: row['allowed_executions'] as unknown,
            }),
          };
        },
        async grant(projectId, principalId, grants, owner, at, actor) {
          await sql`INSERT INTO project_members (participant_id,project_id,created_at,updated_at,updated_by,is_owner,allowed_proposals,allowed_executions)
            VALUES (${principalId},${projectId},${at},${at},${actor},${owner},${sql.json(grants.allowed_proposals)},${sql.json(grants.allowed_executions)})
            ON CONFLICT (participant_id,project_id) DO UPDATE SET deleted_at=NULL,updated_at=excluded.updated_at,updated_by=excluded.updated_by,allowed_proposals=excluded.allowed_proposals,allowed_executions=excluded.allowed_executions`;
        },
        async revoke(projectId, principalId, at, actor) {
          await sql`UPDATE project_members SET deleted_at=${at},updated_at=${at},updated_by=${actor} WHERE project_id=${projectId} AND participant_id=${principalId} AND is_owner=false AND deleted_at IS NULL`;
        },
        async saveDirectory(projection) {
          const project = projection.project;
          if (project === null) return;
          await sql`INSERT INTO projects (id,title,purpose,boundary,status,current_state_version,acceptance_criteria,last_event_seq,created_at,updated_at,updated_by)
            VALUES (${project.id},${project.title},${project.purpose ?? null},${project.boundary ?? null},${project.status},${project.current_state_version},${sql.json(project.acceptance_criteria ?? [])},${projection.seq},${project.created_at},${project.updated_at ?? project.created_at},${project.updated_by ?? null})
            ON CONFLICT (id) DO UPDATE SET title=excluded.title,purpose=excluded.purpose,boundary=excluded.boundary,status=excluded.status,current_state_version=excluded.current_state_version,acceptance_criteria=excluded.acceptance_criteria,last_event_seq=excluded.last_event_seq,updated_at=excluded.updated_at,updated_by=excluded.updated_by`;
        },
        async audit(action, actor, target, at) {
          await sql`INSERT INTO instance_audit (action,actor_id,target_id,occurred_at) VALUES (${action},${actor},${target},${at})`;
        },
      };
      return operation(context);
    });
    // postgres.js maps transaction tuple results; this port returns the callback's value unchanged.
    return result as T;
  }
}
