import fs from 'node:fs';
import path from 'node:path';

import { parseTomlPairs } from './toml.js';

/**
 * Default remote resolution (spec: a repo `navis.toml` may omit `remote`;
 * the fall-through is the operator's global `$HOME/.navis/config.toml`).
 *
 * The global file is operator-owned, not spec-enforced, so the read is
 * permissive: unknown keys are ignored and only `remote` is extracted. An
 * absent or malformed file yields `null`; the caller refuses to upload
 * rather than guess a destination.
 */

/** Reads `remote` from the global config; `null` when absent or unset. */
export function loadGlobalRemote(home: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, '.navis', 'config.toml'), 'utf8');
  } catch {
    // no config file at this home — the repo override must carry the remote
    return null;
  }
  const scanned = parseTomlPairs(raw);
  if (!scanned.ok) return null;
  const remote = scanned.pairs.get('remote');
  return remote !== undefined && remote.length > 0 ? remote : null;
}

/** Repo override wins; otherwise the operator's global default. */
export function resolveRemote(repoRemote: string | null, home: string): string | null {
  return repoRemote ?? loadGlobalRemote(home);
}
