import { z } from 'zod';
import {
  createProjectRequestSchema,
  projectCommandSchema,
  projectMemberRequestSchema,
  assistanceRequestSchema,
  loadContextRequestSchema,
  searchProjectsRequestSchema,
} from '@navis/contracts';

export const remoteSchema = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname)))
    );
  }, 'remote must use HTTPS or a local HTTP endpoint')
  .transform((value) => value.replace(/\/$/, ''));
const projectId = createProjectRequestSchema.shape.project_id;
const key = z.string().min(1).max(128);
const step = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user.message'), body: z.string().max(64_000) }),
  z.strictObject({ kind: z.literal('agent.message'), body: z.string().max(64_000) }),
  z.strictObject({
    kind: z.literal('tool.call.requested'),
    tool: z.string().min(1).max(128),
    parameters: z.json(),
  }),
  z.strictObject({
    kind: z.literal('tool.call.result'),
    tool: z.string().min(1).max(128),
    result: z.json(),
  }),
]);

/** One CLI invocation becomes one bounded local request; credentials never ride inside it. */
export const bridgeRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('ping') }),
  z.strictObject({ op: z.literal('status') }),
  z.strictObject({
    op: z.literal('configure'),
    remote: remoteSchema,
    credential_file: z.string().min(1).max(4096),
  }),
  z.strictObject({
    op: z.literal('project.create'),
    request: createProjectRequestSchema,
    key,
    cwd: z.string().max(4096).optional(),
  }),
  z.strictObject({ op: z.literal('project.state'), project_id: projectId }),
  z.strictObject({
    op: z.literal('project.command'),
    project_id: projectId,
    command: projectCommandSchema,
    key,
  }),
  z.strictObject({
    op: z.literal('project.member'),
    project_id: projectId,
    request: projectMemberRequestSchema,
    key,
  }),
  z.strictObject({ op: z.literal('bind'), cwd: z.string().min(1).max(4096) }),
  z.strictObject({
    op: z.literal('capture'),
    event_id: projectId,
    cwd: z.string().min(1).max(4096),
    step,
    session_id: z.string().min(1).max(128),
    privacy: z.enum(['metadata', 'local-only']).default('metadata'),
  }),
  z.strictObject({ op: z.literal('sync') }),
  z.strictObject({
    op: z.literal('hook.session.start'),
    request_id: projectId,
    cwd: z.string().min(1).max(4096),
  }),
  z.strictObject({ op: z.literal('stop') }),
  z.strictObject({ op: z.literal('project.context'), request: loadContextRequestSchema }),
  z.strictObject({ op: z.literal('project.search'), request: searchProjectsRequestSchema }),
  z.strictObject({
    op: z.literal('assistance.request'),
    project_id: projectId,
    request: assistanceRequestSchema,
    key,
  }),
  z.strictObject({ op: z.literal('assistance.status'), project_id: projectId, job_id: projectId }),
]);
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
