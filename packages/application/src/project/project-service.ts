import { z } from 'zod';
import {
  createProjectRequestSchema,
  parseCanonicalWorkEventPayload,
  projectCommandSchema,
  projectCommandMode,
  type CreateProjectRequest,
  type ProjectCommand,
  type ProjectMemberRequest,
  type ProjectSnapshot,
} from '@navis/contracts';
import {
  canonicalJson,
  eventEnvelopeSchema,
  hasCapability,
  defaultCapabilities,
  ProjectStateKernel,
  uuidv7,
  type StateEvent,
  type KernelProjection,
  type Capabilities,
} from '@navis/domain';
import { dispatchCommand, type DispatchResponse } from '../intake/dispatch-command.js';
import { executeKernelCommand } from './kernel-command.js';
import type {
  InstancePrincipal,
  ProjectWorkspace,
  ProjectTransaction,
} from '../ports/project-workspace.js';

/** The local instance bounds replay work and refuses oversized projects explicitly. */
export const MAX_PROJECT_EVENTS = 100_000;

type ProjectStateView = Omit<ProjectSnapshot, 'projection'> & {
  readonly projection: KernelProjection;
};

export class ProjectOperationError extends Error {
  constructor(
    readonly code: 'denied' | 'conflict' | 'limit',
    message: string,
  ) {
    super(message);
  }
}

function defaultGrants(kind: InstancePrincipal['kind']): Capabilities {
  return defaultCapabilities(kind, [
    ...projectCommandSchema.options.map((schema) => ({
      operation: schema.shape.type.value,
      mode: projectCommandMode(schema.shape.type.value),
    })),
    { operation: 'assistance.request', mode: 'propose' },
  ]);
}

async function loadKernel(tx: ProjectTransaction, projectId: string): Promise<ProjectStateKernel> {
  if ((await tx.events.headSeq(projectId)) > MAX_PROJECT_EVENTS)
    throw new ProjectOperationError('limit', 'project replay limit exceeded');
  const events = await tx.events.loadEvents(projectId, 0);
  return ProjectStateKernel.fromEvents(
    events.map((event) => ({
      seq: event.seq,
      type: event.event_type,
      data: event.payload,
      actor: event.actor_participant_id ?? null,
      at: event.occurred_at,
      state_version: event.state_version,
      schema_version: event.event_schema_version,
    })),
    undefined,
    parseCanonicalWorkEventPayload,
  );
}

async function persist(
  tx: ProjectTransaction,
  projectId: string,
  kernel: ProjectStateKernel,
  previousSeq: number,
  at: string,
): Promise<void> {
  if (kernel.currentSeq > MAX_PROJECT_EVENTS)
    throw new ProjectOperationError('limit', 'project event limit exceeded');
  const events = kernel.events
    .filter((event) => event.seq > previousSeq)
    .map((event: StateEvent) =>
      eventEnvelopeSchema.parse({
        event_id: uuidv7(),
        project_id: projectId,
        seq: event.seq,
        aggregate_type: 'project',
        aggregate_id: projectId,
        aggregate_revision: event.seq,
        event_type: event.type,
        event_schema_version: event.schema_version,
        occurred_at: event.at,
        recorded_at: at,
        actor_participant_id: event.actor ?? null,
        payload: event.data,
        metadata: {},
        privacy_class: 'audit',
        state_version: event.state_version,
      }),
    );
  await tx.events.append(projectId, events, previousSeq);
  await tx.saveDirectory(kernel.projection);
}

async function requirePrincipal(tx: ProjectTransaction, actor: string): Promise<InstancePrincipal> {
  const principal = await tx.principal(actor);
  if (principal === null) throw new ProjectOperationError('denied', 'principal unavailable');
  return principal;
}

export class ProjectService {
  constructor(
    private readonly workspace: ProjectWorkspace,
    private readonly now: () => string,
  ) {}

  /** Creates initial authority and owner grants atomically; identical retries replay the outcome. */
  async create(actor: string, input: CreateProjectRequest, key: string): Promise<DispatchResponse> {
    const request = createProjectRequestSchema.parse(input);
    return this.workspace.transaction(request.project_id, async (tx) => {
      const principal = await requirePrincipal(tx, actor);
      return dispatchCommand(
        tx.inbox,
        {
          projectId: request.project_id,
          idempotencyKey: key,
          commandType: 'project.create',
          payload: { actor, request },
        },
        async () => {
          if ((await tx.events.headSeq(request.project_id)) !== 0)
            throw new ProjectOperationError('conflict', 'project already exists');
          const at = this.now();
          const kernel = new ProjectStateKernel();
          kernel.registerParticipant({
            participant_id: actor,
            type: principal.kind,
            display_name: principal.name,
            at,
          });
          const result = kernel.createProject({
            project_id: request.project_id,
            actor,
            at,
            title: request.title,
            expected_version: 0,
            ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
            ...(request.boundary === undefined ? {} : { boundary: request.boundary }),
            ...(request.acceptance_criteria === undefined
              ? {}
              : { acceptance_criteria: request.acceptance_criteria }),
          });
          if (!result.ok) return result;
          await persist(tx, request.project_id, kernel, 0, at);
          await tx.grant(request.project_id, actor, defaultGrants(principal.kind), true, at, actor);
          await tx.audit('project.created', actor, request.project_id, at);
          return {
            ok: true,
            value: {
              project_id: request.project_id,
              state_version: kernel.stateVersion,
              ledger_seq: kernel.currentSeq,
            },
          };
        },
      );
    });
  }

  /** Authorizes against current grants and commits the kernel outcome with its retry identity. */
  command(
    actor: string,
    projectId: string,
    input: ProjectCommand,
    key: string,
  ): Promise<DispatchResponse> {
    const command = projectCommandSchema.parse(input);
    return this.workspace.transaction(projectId, async (tx) => {
      await requirePrincipal(tx, actor);
      const membership = await tx.membership(projectId, actor);
      if (
        membership === null ||
        !hasCapability(membership, command.type, projectCommandMode(command.type))
      )
        throw new ProjectOperationError('denied', 'operation not permitted');
      return dispatchCommand(
        tx.inbox,
        { projectId, idempotencyKey: key, commandType: command.type, payload: { actor, command } },
        async () => {
          const kernel = await loadKernel(tx, projectId);
          const previousSeq = kernel.currentSeq;
          const at = this.now();
          let result = executeKernelCommand(kernel, command, actor, at);
          await persist(tx, projectId, kernel, previousSeq, at);
          if (command.type === 'equip.issue' && result.ok)
            result = {
              ok: true,
              value: {
                ...z.record(z.string(), z.unknown()).parse(result.value),
                allowed_proposals: membership.allowed_proposals,
                allowed_executions: membership.allowed_executions,
              },
            };
          return JSON.parse(canonicalJson(result)) as typeof result;
        },
      );
    });
  }

  /** Only a project owner can grant or revoke another principal's membership. */
  member(
    actor: string,
    projectId: string,
    request: ProjectMemberRequest,
    key: string,
  ): Promise<DispatchResponse> {
    return this.workspace.transaction(projectId, async (tx) => {
      const caller = await tx.membership(projectId, actor);
      if (caller?.owner !== true || actor === request.participant_id)
        throw new ProjectOperationError('denied', 'membership change not permitted');
      const principal = await requirePrincipal(tx, request.participant_id);
      return dispatchCommand(
        tx.inbox,
        {
          projectId,
          idempotencyKey: key,
          commandType: 'project.member',
          payload: { actor, request },
        },
        async () => {
          const at = this.now();
          if (request.action === 'revoke') await tx.revoke(projectId, principal.id, at, actor);
          else {
            const kernel = await loadKernel(tx, projectId);
            const seq = kernel.currentSeq;
            if (kernel.projection.participants[principal.id] === undefined)
              kernel.registerParticipant({
                participant_id: principal.id,
                type: principal.kind,
                display_name: principal.name,
                at,
              });
            await persist(tx, projectId, kernel, seq, at);
            await tx.grant(
              projectId,
              principal.id,
              defaultGrants(principal.kind),
              false,
              at,
              actor,
            );
          }
          await tx.audit(`membership.${request.action}`, actor, principal.id, at);
          return { ok: true, value: { participant_id: principal.id, action: request.action } };
        },
      );
    });
  }

  authorize(
    actor: string,
    projectId: string,
    operation: string,
    mode: 'propose' | 'execute',
  ): Promise<void> {
    return this.workspace.transaction(projectId, async (tx) => {
      await requirePrincipal(tx, actor);
      const membership = await tx.membership(projectId, actor);
      if (membership === null || !hasCapability(membership, operation, mode))
        throw new ProjectOperationError('denied', 'operation not permitted');
    });
  }

  async canCapture(actor: string, projectId: string): Promise<boolean> {
    return (await this.state(actor, projectId)).privacy_class !== 'local-only';
  }

  /** Returns one bounded, authorized ledger observation; capacity overflow fails without truncation. */
  state(actor: string, projectId: string): Promise<ProjectStateView> {
    return this.workspace.transaction(projectId, async (tx) => {
      const membership = await tx.membership(projectId, actor);
      if (membership === null) throw new ProjectOperationError('denied', 'project unavailable');
      const kernel = await loadKernel(tx, projectId);
      return {
        project_id: projectId,
        state_version: kernel.stateVersion,
        ledger_seq: kernel.currentSeq,
        projection: {
          ...kernel.projection,
          assets: Object.fromEntries(kernel.listAssets().map((asset) => [asset.id, asset])),
        },
        capabilities: {
          allowed_proposals: membership.allowed_proposals,
          allowed_executions: membership.allowed_executions,
        },
        privacy_class: kernel.projection.policy?.capture_privacy ?? 'metadata',
      };
    });
  }
}
