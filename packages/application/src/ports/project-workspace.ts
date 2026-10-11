import type {
  Capabilities,
  CommandInbox,
  DeviceAuthPort,
  EventStore,
  KernelProjection,
} from '@navis/domain';

export interface InstancePrincipal {
  readonly id: string;
  readonly kind: 'human' | 'agent';
  readonly name: string;
}
export interface ProjectMembership extends Capabilities {
  readonly owner: boolean;
}
export interface ProjectTransaction {
  readonly events: EventStore;
  readonly inbox: CommandInbox;
  readonly devices: DeviceAuthPort;
  principal(id: string): Promise<InstancePrincipal | null>;
  putPrincipal(principal: InstancePrincipal, at: string): Promise<void>;
  membership(projectId: string, participantId: string): Promise<ProjectMembership | null>;
  grant(
    projectId: string,
    principalId: string,
    grants: Capabilities,
    owner: boolean,
    at: string,
    actor: string,
  ): Promise<void>;
  revoke(projectId: string, principalId: string, at: string, actor: string): Promise<void>;
  saveDirectory(projection: KernelProjection): Promise<void>;
  audit(action: string, actor: string, target: string, at: string): Promise<void>;
}

/** Serializes a project's writes and commits every injected port operation together. */
export interface ProjectWorkspace {
  transaction<T>(scope: string, operation: (tx: ProjectTransaction) => Promise<T>): Promise<T>;
}
