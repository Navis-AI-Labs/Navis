import { projectCommandSchema, type ProjectCommand } from '@navis/contracts';
import { assetKindSchema, assetContentSchema, type ProjectStateKernel } from '@navis/domain';
import type { DispatchResultValue } from '../intake/dispatch-command.js';

/** Omitted wire fields must stay absent at the domain's exact-optional boundary. */
function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

/** Explicit transport-to-command mapping; no dynamic access to kernel methods. */
export function executeKernelCommand(
  kernel: ProjectStateKernel,
  input: ProjectCommand,
  actor: string,
  at: string,
): DispatchResultValue {
  const cmd = { ...defined(projectCommandSchema.parse(input)), actor, at };
  switch (cmd.type) {
    case 'work.create':
      return kernel.createWork(cmd);
    case 'work.cancel':
      return kernel.cancelWork(cmd);
    case 'work.redirect':
      return kernel.redirectWork(cmd);
    case 'project.boundary':
      return kernel.updateBoundary(cmd);
    case 'project.status':
      return kernel.setProjectStatus(cmd);
    case 'project.policy':
      return kernel.updatePolicy(cmd);
    case 'equip.issue':
      return kernel.issueEquip({ ...cmd, participant_id: actor });
    case 'return.submit': {
      const { candidates, effects, ...base } = cmd;
      return kernel.submitReturn({
        ...base,
        ...(candidates === undefined
          ? {}
          : {
              candidates: candidates.map((seed) => ({
                kind: assetKindSchema.parse(seed.kind),
                ...(seed.provenance === undefined ? {} : { provenance: seed.provenance }),
                ...(seed.content === undefined
                  ? {}
                  : { content: assetContentSchema.parse(seed.content) }),
              })),
            }),
        ...(effects === undefined ? {} : { effects: effects.map(defined) }),
      });
    }
    case 'asset.propose':
      return kernel.createAsset({
        actor,
        at,
        expected_version: cmd.expected_version,
        scope: 'project',
        kind: assetKindSchema.parse(cmd.kind),
        ...(cmd.provenance === undefined ? {} : { provenance: cmd.provenance }),
        ...(cmd.content === undefined ? {} : { content: assetContentSchema.parse(cmd.content) }),
      });
    case 'asset.accept':
      return kernel.acceptAsset(cmd);
    case 'asset.transition':
      return kernel.transitionAsset(cmd);
    case 'hold.register':
      return kernel.registerHold(cmd);
    case 'hold.transition':
      return kernel.transitionHold(cmd);
    case 'effect.intent':
      return kernel.recordEffectIntent(cmd);
    case 'effect.begin':
      return kernel.beginEffectExecution(cmd);
    case 'effect.reset':
      return kernel.resetEffectExecution(cmd);
    case 'effect.close':
      return kernel.closeEffect(cmd);
    case 'effect.cancel':
      return kernel.cancelEffectLate(cmd);
    case 'delivery.record':
      return kernel.deliver(cmd);
    case 'delivery.confirm':
      return kernel.confirmDelivery(cmd);
    case 'direction.propose':
      return kernel.proposeDirection(cmd);
    case 'direction.resolve':
      return kernel.resolveDirection(cmd);
    case 'run.start':
      return kernel.startRun(cmd);
    case 'run.transition':
      return kernel.transitionRun(cmd);
    case 'intervention.open':
      return kernel.openIntervention(cmd);
    case 'intervention.close':
      return kernel.closeIntervention(cmd);
  }
}
