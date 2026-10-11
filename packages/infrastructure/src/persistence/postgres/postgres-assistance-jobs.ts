import { z } from 'zod';
import type postgres from 'postgres';
import { assistanceRequestSchema, type AssistanceRequest } from '@navis/contracts';
import { hashCommandPayload, uuidv7 } from '@navis/domain';
import {
  AssistanceCapacityError,
  type AssistanceJob,
  type AssistanceJobs,
} from '@navis/application';

const storedJobSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  actor_id: z.string(),
  request: assistanceRequestSchema,
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  attempts: z.number().int().nonnegative(),
  output: z.string().nullable(),
  result: z.unknown(),
  error: z.string().nullable(),
  claim_token: z.string().nullable(),
});
function job(row: Record<string, unknown>): AssistanceJob {
  const parsed = storedJobSchema.safeParse(row);
  if (!parsed.success) throw new Error('invalid stored assistance job');
  const value = parsed.data;
  return {
    id: value.id,
    projectId: value.project_id,
    actor: value.actor_id,
    request: value.request,
    status: value.status,
    attempts: value.attempts,
    output: value.output,
    result: value.result ?? null,
    error: value.error,
    claim: value.claim_token,
  };
}
export class PostgresAssistanceJobs implements AssistanceJobs {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly dailyLimit = 100,
    private readonly pendingLimit = 32,
  ) {}
  async submit(
    projectId: string,
    actor: string,
    key: string,
    request: AssistanceRequest,
  ): Promise<AssistanceJob> {
    const hash = hashCommandPayload({ actor, request });
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('navis-assistance-budget'))`;
      const [existing] =
        await tx`SELECT * FROM assistance_jobs WHERE project_id=${projectId} AND idempotency_key=${key}`;
      if (existing !== undefined) {
        if (existing['payload_hash'] !== hash)
          throw new Error('idempotency-key-collides-with-different-payload');
        return job(existing);
      }
      const [budget] =
        await tx`SELECT count(*) FILTER (WHERE created_at>now()-interval '24 hours') AS daily,
        count(*) FILTER (WHERE status IN ('pending','running')) AS pending FROM assistance_jobs`;
      if (
        Number(budget?.['daily']) >= this.dailyLimit ||
        Number(budget?.['pending']) >= this.pendingLimit
      )
        throw new AssistanceCapacityError();
      const id = uuidv7();
      const [row] =
        await tx`INSERT INTO assistance_jobs(id,project_id,actor_id,idempotency_key,payload_hash,request,status)
        VALUES (${id},${projectId},${actor},${key},${hash},${tx.json(request)},'pending') RETURNING *`;
      if (row === undefined) throw new Error('assistance insertion returned no row');
      return job(row);
    });
  }
  async get(id: string): Promise<AssistanceJob | null> {
    const [row] = await this.sql`SELECT * FROM assistance_jobs WHERE id=${id}`;
    return row === undefined ? null : job(row);
  }
  async claim(): Promise<AssistanceJob | null> {
    const [row] = await this.sql`WITH next AS (
      SELECT id FROM assistance_jobs WHERE (status='pending' AND available_at<=now()) OR (status='running' AND lease_until<now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE assistance_jobs SET status='running',attempts=attempts+1,claim_token=${uuidv7()},lease_until=now()+interval '2 minutes',updated_at=now()
      WHERE id IN (SELECT id FROM next) RETURNING *`;
    return row === undefined ? null : job(row);
  }
  async generated(id: string, claim: string, text: string, model: string): Promise<boolean> {
    const rows = await this
      .sql`UPDATE assistance_jobs SET output=${text},result=jsonb_build_object('model_name',${model}::text),updated_at=now() WHERE id=${id} AND claim_token=${claim} AND status='running' RETURNING id`;
    return rows.length === 1;
  }
  async complete(id: string, claim: string, result: unknown): Promise<void> {
    await this
      .sql`UPDATE assistance_jobs SET status='completed',result=${this.sql.json(JSON.parse(JSON.stringify(result)) as postgres.JSONValue)},claim_token=NULL,lease_until=NULL,updated_at=now() WHERE id=${id} AND claim_token=${claim}`;
  }
  async fail(id: string, claim: string, code: string, retry: boolean): Promise<void> {
    await this
      .sql`UPDATE assistance_jobs SET status=${retry ? 'pending' : 'failed'},error=${code},claim_token=NULL,lease_until=NULL,available_at=now()+interval '10 seconds',updated_at=now() WHERE id=${id} AND claim_token=${claim}`;
  }
}
