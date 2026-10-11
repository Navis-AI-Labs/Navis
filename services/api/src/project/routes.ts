import { z } from 'zod';
import {
  createProjectRequestSchema,
  projectCommandSchema,
  projectMemberRequestSchema,
  assistanceRequestSchema,
} from '@navis/contracts';
import {
  ProjectOperationError,
  type ProjectService,
  type AssistanceService,
} from '@navis/application';
import {
  AuthorizationDeniedError,
  BadRequestError,
  ConflictError,
  ServiceUnavailableError,
} from '../platform/errors.js';
import type { ServiceRoute } from '../platform/server.js';

function idempotencyKey(
  headers: Record<string, string | string[] | undefined> | undefined,
): string {
  const key = headers?.['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length === 0 || key.length > 128)
    throw new BadRequestError(
      'A non-empty Idempotency-Key header of at most 128 characters is required.',
    );
  return key;
}

/** Project policy remains in Application; the route translates transport and failures only. */
export function projectRoutes(
  service: ProjectService,
  participant: () => string | null,
  assistance?: AssistanceService,
): readonly ServiceRoute[] {
  const caller = (): string => {
    const id = participant();
    if (id === null) throw new AuthorizationDeniedError();
    return id;
  };
  const routes: ServiceRoute[] = [
    {
      method: 'POST',
      path: '/api/projects',
      requiresBody: true,
      handle: (input, _context, headers) =>
        service.create(caller(), createProjectRequestSchema.parse(input), idempotencyKey(headers)),
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/commands',
      requiresBody: true,
      handle: (input, _context, headers) => {
        const parsed = z
          .strictObject({
            projectId: createProjectRequestSchema.shape.project_id,
            command: projectCommandSchema,
          })
          .parse(input);
        return service.command(caller(), parsed.projectId, parsed.command, idempotencyKey(headers));
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/members',
      requiresBody: true,
      handle: (input, _context, headers) => {
        const { projectId, ...member } = z
          .strictObject({
            projectId: createProjectRequestSchema.shape.project_id,
            ...projectMemberRequestSchema.shape,
          })
          .parse(input);
        return service.member(caller(), projectId, member, idempotencyKey(headers));
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/snapshot',
      requiresBody: false,
      handle: (input) => {
        const { projectId } = z
          .strictObject({ projectId: createProjectRequestSchema.shape.project_id })
          .parse(input);
        return service.state(caller(), projectId);
      },
    },
  ];
  if (assistance !== undefined)
    routes.push(
      {
        method: 'POST',
        path: '/api/projects/:projectId/assistance',
        requiresBody: true,
        handle: (input, _context, headers) => {
          const { projectId, ...request } = z
            .strictObject({
              projectId: createProjectRequestSchema.shape.project_id,
              ...assistanceRequestSchema.shape,
            })
            .parse(input);
          return assistance.submit(caller(), projectId, idempotencyKey(headers), request);
        },
      },
      {
        method: 'GET',
        path: '/api/projects/:projectId/assistance/:jobId',
        requiresBody: false,
        handle: (input) => {
          const { projectId, jobId } = z
            .strictObject({
              projectId: createProjectRequestSchema.shape.project_id,
              jobId: createProjectRequestSchema.shape.project_id,
            })
            .parse(input);
          return assistance.status(caller(), projectId, jobId);
        },
      },
    );
  return routes.map((route) => ({
    ...route,
    async handle(input, context, headers) {
      try {
        const result = await route.handle(input, context, headers);
        if (
          typeof result === 'object' &&
          result !== null &&
          'status' in result &&
          result.status === 'failed'
        )
          throw new ConflictError('project/command-rejected', result);
        return result;
      } catch (error) {
        if (error instanceof ProjectOperationError) {
          if (error.code === 'denied') throw new AuthorizationDeniedError();
          throw new ConflictError(
            error.code === 'limit' ? 'project/limit-exceeded' : 'project/conflict',
          );
        }
        if (
          error instanceof Error &&
          (error.message.startsWith('version-conflict:') ||
            error.message === 'idempotency-key-collides-with-different-payload')
        )
          throw new ConflictError('project/conflict');
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['55P03', '57014', '57P01', 'ECONNREFUSED'].includes(String(error.code))
        )
          throw new ServiceUnavailableError();
        throw error;
      }
    },
  }));
}
