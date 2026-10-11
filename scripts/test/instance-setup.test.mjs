import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

function fixture(t, key) {
  const root = mkdtempSync(path.join(tmpdir(), 'navis-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts/local-instance.mjs');
  copyFileSync(fileURLToPath(new URL('../local-instance.mjs', import.meta.url)), script);
  copyFileSync(
    fileURLToPath(new URL('../client-installation.mjs', import.meta.url)),
    path.join(root, 'scripts/client-installation.mjs'),
  );
  copyFileSync(
    fileURLToPath(new URL('../package-deployment.mjs', import.meta.url)),
    path.join(root, 'scripts/package-deployment.mjs'),
  );
  const security = path.join(root, 'packages/bridge-daemon/src/security');
  mkdirSync(security, { recursive: true });
  copyFileSync(
    fileURLToPath(
      new URL('../../packages/bridge-daemon/src/security/windows-access.ps1', import.meta.url),
    ),
    path.join(security, 'windows-access.ps1'),
  );
  const credential = path.join(root, 'provider-key');
  writeFileSync(credential, key, { mode: 0o600 });
  const args = [
    script,
    'setup',
    '--model-base-url',
    'https://provider.example/v1',
    '--model',
    'test-model',
    '--model-key-file',
    credential,
  ];
  return { root, args };
}
test('setup creates matching private connection/password files and preserves existing configuration', (t) => {
  const f = fixture(t, 'synthetic-provider-key-for-setup');
  const output = execFileSync(process.execPath, f.args, { encoding: 'utf8' });
  const envPath = path.join(f.root, '.local/runtime.env');
  const config = readFileSync(envPath, 'utf8');
  const connection = new URL(
    readFileSync(path.join(f.root, '.local/secrets/database-url'), 'utf8').trim(),
  );
  const password = readFileSync(
    path.join(f.root, '.local/secrets/postgres-password'),
    'utf8',
  ).trim();
  assert.equal(connection.hostname, 'postgres');
  assert.equal(connection.password, password);
  assert(!config.includes(password));
  assert(!output.includes('synthetic-provider-key-for-setup'));
  if (process.platform !== 'win32') assert.equal(statSync(envPath).mode & 0o777, 0o600);
  else
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(f.root, 'packages/bridge-daemon/src/security/windows-access.ps1'),
      '-Action',
      'check',
      '-LiteralPath',
      envPath,
    ]);
  execFileSync(process.execPath, f.args);
  assert.equal(readFileSync(envPath, 'utf8'), config);
});
test('setup refuses an invalid key before creating partial private configuration', (t) => {
  const f = fixture(t, 'invalid');
  const result = spawnSync(process.execPath, f.args, { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid model credential/);
  assert(!existsSync(path.join(f.root, '.local')));
});

test('named credentials cannot escape the private credential directory', (t) => {
  const f = fixture(t, 'synthetic-provider-key-for-setup');
  const result = spawnSync(
    process.execPath,
    [f.args[0], 'provision', '--kind', 'agent', '--credential-name', '../outside'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /simple filename/);
  assert(!existsSync(path.join(f.root, '.local')));
});

test('a named human credential cannot be reused as an agent credential', (t) => {
  const f = fixture(t, 'synthetic-provider-key-for-setup');
  execFileSync(process.execPath, f.args);
  const dir = path.join(f.root, '.local/credentials');
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(path.join(dir, 'existing.json'), JSON.stringify({ participant_type: 'human' }), {
    mode: 0o600,
  });
  const result = spawnSync(
    process.execPath,
    [f.args[0], 'provision', '--kind', 'agent', '--credential-name', 'existing'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /different identity kind/);
});

test('skill installation requires a client and keeps generated paths outside the source repository', (t) => {
  const f = fixture(t, 'synthetic-provider-key-for-setup');
  const destination = mkdtempSync(path.join(tmpdir(), 'navis-skill-'));
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  const args = [f.args[0], 'install-skill', '--skill-dir', destination];
  assert.match(
    spawnSync(process.execPath, args, { encoding: 'utf8' }).stderr,
    /install-client first/,
  );
  const bin = path.join(f.root, '.local/bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'navis-entry.mjs'), '');
  const sourceDir = path.join(f.root, 'integrations/skills/navis');
  mkdirSync(sourceDir, { recursive: true });
  const source = '---\nname: navis\ndescription: Use Navis\n---\n';
  writeFileSync(path.join(sourceDir, 'SKILL.md'), source);
  const rejected = spawnSync(
    process.execPath,
    [f.args[0], 'install-skill', '--skill-dir', sourceDir],
    { encoding: 'utf8' },
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /outside the source repository/);
  execFileSync(process.execPath, args);
  assert.equal(readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8'), source);
  assert(readFileSync(path.join(destination, 'SKILL.md'), 'utf8').includes('navis-entry.mjs'));
  writeFileSync(path.join(destination, 'SKILL.md'), '---\nname: unrelated\n---\n');
  assert.match(spawnSync(process.execPath, args, { encoding: 'utf8' }).stderr, /another skill/);
});
