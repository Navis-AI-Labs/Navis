import { describe, expect, it } from 'vitest';

import { ProjectStateKernel } from '../src/index.js';
import type { AssetRow } from '../src/state/projection.js';

/*
 * Regression pins for change minimal-read-surface: the kernel's read
 * paths (list/get-by-id) route through the same scope predicate used by
 * equip derivation; out-of-scope rows look "absent" to read clients.
 */

const T0 = '2026-09-18T00:00:00.000Z';
const HUMAN = '01900000-0000-7000-8000-000000000001';

function seed(): ProjectStateKernel {
  const k = new ProjectStateKernel();
  k.registerParticipant({ participant_id: HUMAN, type: 'human', at: T0 });
  k.createProject({ actor: HUMAN, at: T0, title: 'p', expected_version: 0 });
  return k;
}

function createAsset(
  k: ProjectStateKernel,
  scope: 'project' | 'participant' | 'session' | 'task',
): AssetRow {
  const created = k.createAsset({
    actor: HUMAN,
    at: T0,
    kind: 'artifact',
    scope,
    content: { media_type: 'text/plain', storage: 'inline', sha256: 'a'.repeat(64) },
    expected_version: k.stateVersion,
  });
  if (!created.ok) throw new Error('createAsset seed failed');
  return created.value;
}

describe('listAssets routes through the scope predicate', () => {
  it('hides participant/session/task assets from the list', () => {
    const k = seed();
    const inScope = createAsset(k, 'project');
    createAsset(k, 'participant');
    createAsset(k, 'session');
    createAsset(k, 'task');

    const listed = k.listAssets();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(inScope.id);
  });

  it('assets still in candidate stage are listed (alive, unaccepted, in-scope)', () => {
    const k = seed();
    const created = createAsset(k, 'project');

    const listed = k.listAssets();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
    expect(listed[0]?.lifecycle).toBe('candidate');
  });
});

describe('getAssetById returns not-found for out-of-scope rows', () => {
  it('a participant-scope row is indistinguishable from "does not exist"', () => {
    const k = seed();
    const hidden = createAsset(k, 'participant');

    const lookedUp = k.getAssetById(hidden.id);
    expect(lookedUp).toBeUndefined();
  });

  it('same id exists in the raw projection (cross-scope leak cannot happen silently)', () => {
    const k = seed();
    const hidden = createAsset(k, 'participant');

    // raw projection has it; the read path must refuse
    expect(k.projection.assets[hidden.id]).toBeDefined();
    expect(k.getAssetById(hidden.id)).toBeUndefined();
  });

  it('an in-scope row is returned', () => {
    const k = seed();
    const a = createAsset(k, 'project');
    expect(k.getAssetById(a.id)).toBeDefined();
  });

  it('an unknown id returns undefined on both paths', () => {
    const k = seed();
    const listed = k.listAssets();
    expect(listed).toHaveLength(0);
    expect(k.getAssetById('01900000-0000-7000-8000-ffffffffffff')).toBeUndefined();
  });
});
