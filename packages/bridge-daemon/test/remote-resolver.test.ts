import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadGlobalRemote, resolveRemote } from '../src/binding/remote-resolver.js';

/**
 * Global remote resolution covers the two spec boats: a repo-level override
 * always wins, and when the repo stays silent the operator's
 * `$HOME/.navis/config.toml` supplies the default.
 */

const tmpRoots: string[] = [];

function makeHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'navis-home-'));
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe('loadGlobalRemote', () => {
  it('returns null when the config file does not exist', () => {
    expect(loadGlobalRemote(makeHome())).toBeNull();
  });

  it('returns null when the file exists but never assigns remote', () => {
    const home = makeHome();
    mkdirSync(path.join(home, '.navis'), { recursive: true });
    writeFileSync(path.join(home, '.navis', 'config.toml'), 'project_root = "/srv"\n');
    expect(loadGlobalRemote(home)).toBeNull();
  });

  it('returns null for blank lines and comment-only lines', () => {
    const home = makeHome();
    mkdirSync(path.join(home, '.navis'), { recursive: true });
    writeFileSync(path.join(home, '.navis', 'config.toml'), '# just notes\n\n');
    expect(loadGlobalRemote(home)).toBeNull();
  });

  it('returns null when remote has no assignment', () => {
    const home = makeHome();
    mkdirSync(path.join(home, '.navis'), { recursive: true });
    writeFileSync(path.join(home, '.navis', 'config.toml'), 'remote\n');
    expect(loadGlobalRemote(home)).toBeNull();
  });

  it('returns null unless the value is double-quoted and non-empty', () => {
    const home = makeHome();
    mkdirSync(path.join(home, '.navis'), { recursive: true });
    writeFileSync(path.join(home, '.navis', 'config.toml'), 'remote = ""\n');
    expect(loadGlobalRemote(home)).toBeNull();
  });

  it('reads the first double-quoted remote assignment', () => {
    const home = makeHome();
    mkdirSync(path.join(home, '.navis'), { recursive: true });
    writeFileSync(
      path.join(home, '.navis', 'config.toml'),
      '# default bridge instance\nremote = "https://navis.example.corp"\nremote = "https://other.invalid"\n',
    );
    expect(loadGlobalRemote(home)).toBe('https://navis.example.corp');
  });
});

describe('resolveRemote', () => {
  it('prefers the repo override over the global default', () => {
    const home = makeHome();
    mkdirSync(path.join(home, '.navis'), { recursive: true });
    writeFileSync(path.join(home, '.navis', 'config.toml'), 'remote = "https://global.invalid"\n');
    expect(resolveRemote('https://repo.invalid', home)).toBe('https://repo.invalid');
  });

  it('falls back to the global default when the repo omits remote', () => {
    const home = makeHome();
    mkdirSync(path.join(home, '.navis'), { recursive: true });
    writeFileSync(
      path.join(home, '.navis', 'config.toml'),
      'remote = "https://navis.example.corp"\n',
    );
    expect(resolveRemote(null, home)).toBe('https://navis.example.corp');
  });

  it('returns null when neither source names a remote', () => {
    expect(resolveRemote(null, makeHome())).toBeNull();
  });
});
