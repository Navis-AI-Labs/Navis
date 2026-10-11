import type { AssistanceRequest } from '@navis/contracts';
export interface AssistanceJob {
  readonly id: string;
  readonly projectId: string;
  readonly actor: string;
  readonly request: AssistanceRequest;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly attempts: number;
  readonly output: string | null;
  readonly result: unknown;
  readonly error: string | null;
  readonly claim: string | null;
}
export interface AssistanceJobs {
  submit(
    projectId: string,
    actor: string,
    key: string,
    request: AssistanceRequest,
  ): Promise<AssistanceJob>;
  get(id: string): Promise<AssistanceJob | null>;
  claim(): Promise<AssistanceJob | null>;
  generated(id: string, claim: string, text: string, model: string): Promise<boolean>;
  complete(id: string, claim: string, result: unknown): Promise<void>;
  fail(id: string, claim: string, code: string, retry: boolean): Promise<void>;
}
export interface ModelProvider {
  readonly modelName?: string;
  generate(prompt: string, requestId: string, signal: AbortSignal): Promise<string>;
}

/** A durable model-job reservation would exceed the configured queue or rolling daily budget. */
export class AssistanceCapacityError extends Error {
  constructor() {
    super('model assistance capacity exceeded');
  }
}
