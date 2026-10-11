import { z } from 'zod';
import { createHash } from 'node:crypto';
import { assistanceRequestSchema, type AssistanceRequest } from '@navis/contracts';
import type { AssistanceJobs, AssistanceJob, ModelProvider } from '../ports/assistance.js';
import { ProjectOperationError, type ProjectService } from '../project/project-service.js';

export class ModelProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}

/** Durable generation never grants the model a command executor or an acceptance identity. */
export class AssistanceService {
  constructor(
    private readonly jobs: AssistanceJobs,
    private readonly projects: ProjectService,
    private readonly model: ModelProvider,
  ) {}
  async submit(actor: string, projectId: string, key: string, input: AssistanceRequest) {
    await this.projects.authorize(actor, projectId, 'assistance.request', 'propose');
    if (!(await this.projects.canCapture(actor, projectId)))
      throw new ProjectOperationError('denied', 'project policy keeps data local');
    return this.view(
      await this.jobs.submit(projectId, actor, key, assistanceRequestSchema.parse(input)),
    );
  }
  async status(actor: string, projectId: string, id: string) {
    await this.projects.authorize(actor, projectId, 'assistance.request', 'propose');
    const job = await this.jobs.get(id);
    if (job?.projectId !== projectId) throw new ProjectOperationError('denied', 'job unavailable');
    return this.view(job);
  }
  private view(job: AssistanceJob) {
    return {
      job_id: job.id,
      project_id: job.projectId,
      status: job.status,
      attempts: job.attempts,
      result: job.result,
      error: job.error,
    };
  }

  async tick(signal: AbortSignal): Promise<boolean> {
    const job = await this.jobs.claim();
    if (job === null) return false;
    if (job.claim === null) throw new Error('claimed job has no lease');
    if (job.attempts > 3) {
      await this.jobs.fail(job.id, job.claim, 'MODEL_RETRY_EXHAUSTED', false);
      return true;
    }
    try {
      await this.projects.authorize(job.actor, job.projectId, 'assistance.request', 'propose');
      if (!(await this.projects.canCapture(job.actor, job.projectId)))
        throw new ProjectOperationError('denied', 'project policy keeps data local');
      const model =
        job.output === null
          ? (this.model.modelName ?? 'unspecified')
          : z.object({ model_name: z.string() }).parse(job.result).model_name;
      const text = job.output ?? (await this.model.generate(job.request.prompt, job.id, signal));
      if (job.output === null && !(await this.jobs.generated(job.id, job.claim, text, model)))
        return true;
      const result = await this.projects.command(
        job.actor,
        job.projectId,
        {
          type: 'asset.propose',
          expected_version: job.request.expected_version,
          kind: 'knowledge',
          provenance: `model:${model};job:${job.id}`,
          content: {
            media_type: 'text/plain',
            storage: 'inline',
            text,
            size: Buffer.byteLength(text),
            sha256: createHash('sha256').update(text).digest('hex'),
          },
        },
        `model-job:${job.id}`,
      );
      if (result.status !== 'applied') throw new ModelProviderError('MODEL_CANDIDATE_REJECTED');
      await this.jobs.complete(job.id, job.claim, result);
    } catch (error) {
      const code =
        error instanceof ModelProviderError
          ? error.code
          : error instanceof ProjectOperationError
            ? 'MODEL_AUTHORIZATION_DENIED'
            : 'MODEL_TASK_FAILED';
      await this.jobs.fail(
        job.id,
        job.claim,
        signal.aborted ? 'MODEL_INTERRUPTED' : code,
        job.attempts < 3 &&
          (signal.aborted ||
            (error instanceof ModelProviderError
              ? error.retryable
              : !(error instanceof ProjectOperationError))),
      );
    }
    return true;
  }
}
