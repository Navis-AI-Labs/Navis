import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `navis.toml` declaration reader (spec: the toml declares the project; the
 * server, not the file, is the trust source).
 *
 * Deliberately strict. This is NOT a TOML library: the allowlist is two
 * top-level keys — `project_id` and `remote`. Anything else (sections,
 * arrays, escapes we did not expect) fails the parse as 'toml-invalid'.
 * That strictness is the spec's tamper posture made concrete: the file is
 * a plaintext assertion with no room for hidden surprises, and the full-file
 * fingerprint of its bytes is what the binding table compares on re-bind.
 *
 * A walk-up directory scan finds the first hit (the spec's nearest-first rule).
 */

export interface TomlDeclaration {
  readonly projectId: string;
  readonly remote: string | null;
}

export type TomlParse =
  | { readonly ok: true; readonly declaration: TomlDeclaration }
  | { readonly ok: false; readonly reason: string };

const TWO_KEY_ALLOWLIST = new Set(['project_id', 'remote']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Generic `key = "value"` line scan shared by the strict repo declaration and
 * the permissive global config. Returns the extracted assignments, or a
 * failure reason for the first malformed line. Quoted values only; escapes
 * are rejected — boring shapes keep tamper surfaces small.
 */
export function parseTomlPairs(
  text: string,
): { ok: true; pairs: Map<string, string> } | { ok: false; reason: string } {
  const pairs = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { ok: false, reason: `toml-invalid:${line}` };
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!value.startsWith('"') || !value.endsWith('"')) {
      return { ok: false, reason: `toml-invalid:${key}` };
    }
    const unescaped = value.slice(1, -1);
    if (unescaped.includes('"') || unescaped.includes('\\')) {
      return { ok: false, reason: `toml-invalid:${key}` };
    }
    // duplicate keys: first declaration wins — later lines are dead text, not overrides
    if (!pairs.has(key)) pairs.set(key, unescaped);
  }
  return { ok: true, pairs };
}

export function parseTomlBytes(bytes: Buffer): TomlParse {
  const text = bytes.toString('utf8').trim();
  if (text.length === 0) return { ok: false, reason: 'toml-empty' };
  const scanned = parseTomlPairs(text);
  if (!scanned.ok) return scanned;
  for (const key of scanned.pairs.keys()) {
    if (!TWO_KEY_ALLOWLIST.has(key)) return { ok: false, reason: `toml-invalid:${key}` };
  }
  const projectId = scanned.pairs.get('project_id');
  if (projectId === undefined) return { ok: false, reason: 'toml-no-project-id' };
  if (!UUID_RE.test(projectId)) return { ok: false, reason: 'toml-invalid-project-id' };
  const remote = scanned.pairs.get('remote');
  return { ok: true, declaration: { projectId, remote: remote ?? null } };
}

/** SHA-256 over the raw bytes; the tamper tripwire. */
export function tomlFingerprint(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Walks `start` upward to the nearest `navis.toml`. Stops at the filesystem
 * root; the first match wins. Missing/unreadable directories fold into 'no
 * toml' like they don't exist — binding is lazy and certainly never noisy.
 */
export function findTomlUp(start: string): { tomlPath: string; bytes: Buffer } | null {
  let dir = path.resolve(start);
  // eslint-countonever-sort-tome: loops break only on filesystem root or found
  for (;;) {
    const candidate = path.join(dir, 'navis.toml');
    try {
      const bytes = fs.readFileSync(candidate);
      return { tomlPath: candidate, bytes };
    } catch {
      // ENOENT/EPERM: fall through to the parent
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
