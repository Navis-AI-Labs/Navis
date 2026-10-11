import { describe, expect, it } from 'vitest';
import {
  capabilitiesSchema,
  hasCapability,
  defaultCapabilities,
} from '../src/schema/capabilities.js';
import { assetContentSchema } from '../src/schema/asset.js';
describe('server capability and content boundaries', () => {
  it('does not upgrade proposal grants into execution', () => {
    const grants = capabilitiesSchema.parse({
      allowed_proposals: ['asset.propose'],
      allowed_executions: ['work.create'],
    });
    expect(hasCapability(grants, 'asset.propose', 'propose')).toBe(true);
    expect(hasCapability(grants, 'asset.propose', 'execute')).toBe(false);
    expect(hasCapability(grants, 'work.create', 'execute')).toBe(true);
    expect(hasCapability(grants, 'asset.accept', 'execute')).toBe(false);
  });
  it('issues only executable grants supported by the verified participant kind', () => {
    const catalog = [
      { operation: 'asset.propose', mode: 'propose' as const },
      { operation: 'work.create', mode: 'execute' as const },
      { operation: 'equip.issue', mode: 'execute' as const },
    ];
    expect(defaultCapabilities('human', catalog).allowed_executions).toEqual([
      'work.create',
      'equip.issue',
    ]);
    expect(defaultCapabilities('agent', catalog)).toEqual({
      allowed_proposals: ['asset.propose'],
      allowed_executions: ['equip.issue'],
    });
  });
  it('keeps inline model output in the ledger and rejects ambiguous external carriers', () => {
    expect(
      assetContentSchema.parse({ media_type: 'text/plain', storage: 'inline', text: 'candidate' })
        .text,
    ).toBe('candidate');
    expect(
      assetContentSchema.safeParse({
        media_type: 'text/plain',
        storage: 'object_ref',
        ref: 'object-a',
        text: 'duplicate',
      }).success,
    ).toBe(false);
  });
});

it('refuses an inline body whose claimed hash differs from its bytes', () => {
  expect(
    assetContentSchema.safeParse({
      media_type: 'text/plain',
      storage: 'inline',
      text: 'actual',
      sha256: '0'.repeat(64),
    }).success,
  ).toBe(false);
});
