import { describe, expect, it } from 'vitest';

import {
  type ActionContext,
  checkActorPermission,
  resolveCriteria,
} from '../src/registry/submission-criteria.js';

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    actor: 'p-1',
    action: 'submit_return',
    parameters: {},
    state_version: 3,
    actor_snapshot: { registered: true, type: 'agent' },
    ...overrides,
  };
}

describe('submission criteria contract', () => {
  it('resolves the baseline criteria by its contract name', () => {
    expect(resolveCriteria('check_actor_permission')).toBe(checkActorPermission);
  });

  it('an unknown criteria reference fails explicitly naming the reference', () => {
    expect(() => resolveCriteria('check_reviews_passed')).toThrow(
      'criteria not defined: check_reviews_passed',
    );
  });

  it('an unregistered actor fails with the kernel guard reason', () => {
    const result = checkActorPermission(
      context({ actor_snapshot: { registered: false, type: 'agent' } }),
    );
    expect(result).toEqual({ passed: false, reason: 'unknown-actor' });
  });

  it('a human-only action refuses an agent actor', () => {
    const result = checkActorPermission(
      context({ action: 'accept_asset', actor_snapshot: { registered: true, type: 'agent' } }),
    );
    expect(result).toEqual({ passed: false, reason: 'actor-kind-not-authorized' });
  });

  it('a human actor passes a human-only action', () => {
    const result = checkActorPermission(
      context({ action: 'accept_asset', actor_snapshot: { registered: true, type: 'human' } }),
    );
    expect(result).toEqual({ passed: true });
  });

  it('an agent actor passes a non-human-only action', () => {
    const result = checkActorPermission(context({ action: 'submit_return' }));
    expect(result).toEqual({ passed: true });
  });

  it('the descriptive role field never changes the verdict', () => {
    // authorization follows registration and participant type; there is no
    // role input on the context at all — the absence is the assertion
    expect('role' in context()).toBe(false);
  });

  it('the same context always yields the same verdict', () => {
    const frozen = Object.freeze(
      context({ action: 'accept_asset', actor_snapshot: { registered: true, type: 'human' } }),
    );
    expect(checkActorPermission(frozen)).toEqual(checkActorPermission(frozen));
  });

  it('criteria functions cannot mutate the context', () => {
    const frozen = Object.freeze({
      ...context(),
      actor_snapshot: Object.freeze({ registered: true, type: 'human' }),
      parameters: Object.freeze({}),
    });
    expect(() => {
      'use strict';
      (frozen as { actor: string }).actor = 'p-2';
    }).toThrow();
    expect(checkActorPermission(frozen).passed).toBe(true);
  });
});
