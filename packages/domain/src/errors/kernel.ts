/**
 * kernel-module error registry — closed, add-only kebab-case tokens
 * resolving to stable `kernel/<token>` URNs.
 *
 * Same discipline as the schema registry: renaming, removing, or reusing
 * a token is a breaking change; the token set forms a literal-keyed const
 * object, so renaming a token fails compilation of dependent code. Domain
 * error objects carry { module, code, urn, details? } and no localized
 * messages — rendering belongs to edge layers.
 *
 * Tuning constants do NOT live here: a constant belongs to the capability
 * file that consumes it (standards 01 rejects cross-capability dumping) —
 * the equip budget and the competitive grace window live in
 * `state/project-state-kernel.ts` with their provenance comments.
 */

export interface KernelError {
  readonly module: 'kernel';
  readonly code: string;
  readonly urn: string;
  readonly details?: Record<string, unknown>;
}

/** The single token→URN source of truth; factories and exhaustiveness tests both read from here. */
export const kernelErrorTokens = {
  forbidden: 'kernel/forbidden',
  'rationale-required': 'kernel/rationale-required',
  'version-conflict': 'kernel/version-conflict',
  'equip-budget-exceeded': 'kernel/equip-budget-exceeded',
  'unaccepted-artifact': 'kernel/unaccepted-artifact',
  'blocking-hold': 'kernel/blocking-hold',
  'unknown-effect-unclosed': 'kernel/unknown-effect-unclosed',
  'project-not-active': 'kernel/project-not-active',
  'open-attempt-exists': 'kernel/open-attempt-exists',
  'causal-context-invalid': 'kernel/causal-context-invalid',
  'causal-actor-unregistered': 'kernel/causal-actor-unregistered',
} as const;

export type KernelErrorToken = keyof typeof kernelErrorTokens;

function kernelError(code: KernelErrorToken, details: Record<string, unknown>): KernelError {
  return { module: 'kernel', code, urn: kernelErrorTokens[code], details };
}

export const kernelErrors = {
  forbidden: (action: string, details: Record<string, unknown> = {}): KernelError =>
    kernelError('forbidden', { action, ...details }),
  rationaleRequired: (action: string): KernelError => kernelError('rationale-required', { action }),
  versionConflict: (expected: number, actual: number): KernelError =>
    kernelError('version-conflict', { expected, actual }),
  equipBudgetExceeded: (factCount: number, serializedLength: number, budget: number): KernelError =>
    kernelError('equip-budget-exceeded', {
      fact_count: factCount,
      serialized_length: serializedLength,
      budget,
    }),
  unacceptedArtifact: (assetId: string, lifecycle: string): KernelError =>
    kernelError('unaccepted-artifact', { asset_id: assetId, lifecycle }),
  blockingHold: (holdIds: readonly string[]): KernelError =>
    kernelError('blocking-hold', { hold_ids: [...holdIds] }),
  unknownEffectUnclosed: (effectIds: readonly string[]): KernelError =>
    kernelError('unknown-effect-unclosed', { effect_ids: [...effectIds] }),
  projectNotActive: (status: string, action: string): KernelError =>
    kernelError('project-not-active', { status, action }),
  openAttemptExists: (assetId: string, targetRef: string, attemptNo: number): KernelError =>
    kernelError('open-attempt-exists', {
      asset_id: assetId,
      target_ref: targetRef,
      open_attempt_no: attemptNo,
    }),
  causalContextInvalid: (reason: string): KernelError =>
    kernelError('causal-context-invalid', { reason }),
  causalActorUnregistered: (participantId: string): KernelError =>
    kernelError('causal-actor-unregistered', { participant_id: participantId }),
} as const;
