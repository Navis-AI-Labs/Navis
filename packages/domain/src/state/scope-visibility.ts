import type { AssetScope } from '../schema/index.js';

/**
 * The single owner of the five-level scope rule for project-side derivations.
 *
 * R0 semantics: an asset is visible inside a project's derived surfaces (Equip
 * verified_facts and active_assets) only at `project` scope. The narrower
 * levels (participant / session / task) stay hidden until asset schemas gain
 * ownership attribution fields, and `organization` belongs outside any
 * project derivation. A derivation site must not compare scope literals
 * inline — the rule changes here or nowhere.
 */
export function scopeVisibleForProject(scope: AssetScope): boolean {
  return scope === 'project';
}
