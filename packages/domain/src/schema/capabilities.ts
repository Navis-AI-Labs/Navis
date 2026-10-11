import { z } from 'zod';

/** Server-owned grants are distinct from a caller's descriptive action list. */
export const capabilitiesSchema = z.strictObject({
  allowed_proposals: z.array(z.string().min(1).max(128)).max(100),
  allowed_executions: z.array(z.string().min(1).max(128)).max(100),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export function hasCapability(
  grants: Capabilities,
  operation: string,
  mode: 'propose' | 'execute',
): boolean {
  return (mode === 'propose' ? grants.allowed_proposals : grants.allowed_executions).includes(
    operation,
  );
}

/** New members receive only the operations admitted for their verified participant kind. */
export function defaultCapabilities(
  kind: 'human' | 'agent',
  catalog: readonly { operation: string; mode: 'propose' | 'execute' }[],
): Capabilities {
  const agentExecutions = new Set([
    'equip.issue',
    'effect.intent',
    'effect.begin',
    'effect.reset',
    'effect.close',
    'effect.cancel',
    'run.start',
    'run.transition',
  ]);
  return {
    allowed_proposals: catalog
      .filter((item) => item.mode === 'propose')
      .map((item) => item.operation),
    allowed_executions: catalog
      .filter(
        (item) =>
          item.mode === 'execute' && (kind === 'human' || agentExecutions.has(item.operation)),
      )
      .map((item) => item.operation),
  };
}
