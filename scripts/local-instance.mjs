import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { pnpmInvocation, writeClientLaunchers, writeClientSkill } from './client-installation.mjs';
import { isolateDeploymentFiles } from './package-deployment.mjs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  readSync,
  appendFileSync,
  renameSync,
  rmSync,
  statSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const local = path.join(root, '.local');
const envFile = path.join(local, 'runtime.env');
const compose = ['compose', '--env-file', envFile];
const magic = Buffer.from('NAVIS-BACKUP-1\n');
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    kind: { type: 'string' },
    'model-base-url': { type: 'string' },
    model: { type: 'string' },
    'model-key-file': { type: 'string' },
    'credential-file': { type: 'string' },
    'credential-name': { type: 'string' },
    'snapshot-file': { type: 'string' },
    'skill-dir': { type: 'string' },
  },
});
const command = positionals[0];
function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0)
    throw new Error(`${program} failed (exit ${String(result.status)})`);
  return result.stdout;
}
function captured(program, args, options = {}) {
  return run(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
}
function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    execFileSync(
      path.win32.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(root, 'packages/bridge-daemon/src/security/windows-access.ps1'),
        '-Action',
        'protect-directory',
        '-LiteralPath',
        dir,
      ],
      { stdio: 'pipe', windowsHide: true, timeout: 10000 },
    );
  } else chmodSync(dir, 0o700);
}
function privateFile(file, bytes) {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}
function backupKey(create = false) {
  const file = path.join(local, 'secrets', 'backup-key');
  if (!existsSync(file)) {
    if (!create) throw new Error('The private backup key is missing');
    privateFile(file, randomBytes(32));
  }
  const key = readFileSync(file);
  if (key.length !== 32) throw new Error('invalid backup key');
  return key;
}
function waitExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`child process exited ${String(code)}`)),
    );
  });
}
function configure() {
  if (existsSync(envFile)) {
    process.stdout.write('Existing private configuration retained.\n');
    return;
  }
  if (process.getuid?.() === 0) throw new Error('Run setup as an unprivileged host user');
  const modelUrl = new URL(values['model-base-url'] ?? '');
  if (
    modelUrl.protocol !== 'https:' ||
    modelUrl.username ||
    modelUrl.password ||
    modelUrl.search ||
    modelUrl.hash
  )
    throw new Error('A credential-free HTTPS model endpoint is required');
  if (!values.model || /[\r\n]/u.test(values.model) || !values['model-key-file'])
    throw new Error('Provide --model and --model-key-file');
  const key = readFileSync(path.resolve(values['model-key-file']), 'utf8').trim();
  if (key.length < 16 || key.length > 512 || /[\r\n]/u.test(key))
    throw new Error('Invalid model credential file');
  privateDir(local);
  privateDir(path.join(local, 'secrets'));
  privateDir(path.join(local, 'backups'));
  const password = randomBytes(32).toString('base64url');
  privateFile(
    path.join(local, 'secrets', 'database-url'),
    `postgres://navis:${password}@postgres:5432/navis\n`,
  );
  privateFile(path.join(local, 'secrets', 'postgres-password'), `${password}\n`);
  privateFile(path.join(local, 'secrets', 'model-key'), `${key}\n`);
  privateFile(
    envFile,
    `NAVIS_MODEL_BASE_URL=${modelUrl.href.replace(/\/$/u, '')}\nNAVIS_MODEL_NAME=${values.model}\nNAVIS_API_PORT=8080\n`,
  );
  backupKey(true);
  process.stdout.write('Private runtime configuration created in .local.\n');
}
function provision() {
  if (values.kind !== 'human' && values.kind !== 'agent')
    throw new Error('Provide --kind human|agent');
  const credentialName = values['credential-name'] ?? values.kind;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(credentialName))
    throw new Error('Credential name must be a simple filename label');
  const dir = path.join(local, 'credentials');
  privateDir(dir);
  const file = path.join(dir, `${credentialName}.json`);
  if (existsSync(file)) {
    let existing;
    try {
      existing = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Error('Existing credential file is invalid');
    }
    if (existing?.participant_type !== values.kind)
      throw new Error(
        'Existing credential has a different identity kind; choose another credential name',
      );
    process.stdout.write(`Existing credential retained: ${file}\n`);
    return;
  }
  const output = captured('docker', [
    ...compose,
    'exec',
    '-T',
    '--user',
    'node',
    'api',
    'node',
    'dist/operator/index.js',
    '--name',
    values.name ?? `Local ${values.kind}`,
    '--kind',
    values.kind,
  ]);
  const credential = JSON.parse(output);
  if (typeof credential.key_secret !== 'string' || credential.participant_type !== values.kind)
    throw new Error('Invalid operator response');
  privateFile(file, `${JSON.stringify(credential, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ credential_file: file, participant_id: credential.participant_id, device_id: credential.device_id })}\n`,
  );
}
function installClient() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 24) throw new Error('Install the client with the pinned Node 24 runtime');
  const target = path.join(local, 'client');
  const previous = path.join(local, 'client.previous');
  privateDir(local);
  if (existsSync(target)) {
    rmSync(previous, { recursive: true, force: true });
    renameSync(target, previous);
  }
  try {
    const deploy = pnpmInvocation([
      '--config.package-import-method=copy',
      '--filter',
      '@navis/cli',
      'deploy',
      '--prod',
      '--legacy',
      target,
    ]);
    run(deploy.program, deploy.args);
    isolateDeploymentFiles(target);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    if (existsSync(previous)) renameSync(previous, target);
    throw error;
  } finally {
    // Legacy deploy records production-only install state even when deployment fails.
    const restore = pnpmInvocation([
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--prod=false',
    ]);
    run(restore.program, restore.args);
  }
  const bin = path.join(local, 'bin');
  privateDir(bin);
  writeClientLaunchers(bin);
  process.stdout.write(
    `Client installed: ${path.join(bin, process.platform === 'win32' ? 'navis.cmd' : 'navis')}\n`,
  );
}

function installSkill() {
  if (!values['skill-dir']) throw new Error('Provide --skill-dir for the Navis skill directory');
  const directory = path.resolve(values['skill-dir']);
  let ancestor = directory;
  const missing = [];
  while (!existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  // Resolve aliases such as /var -> /private/var before enforcing the source boundary.
  const relative = path.relative(realpathSync(root), path.join(realpathSync(ancestor), ...missing));
  if (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
    throw new Error('Install the skill outside the source repository to keep host paths private');
  const bin = path.join(local, 'bin');
  if (!existsSync(path.join(bin, 'navis-entry.mjs')))
    throw new Error('Run pnpm instance install-client first');
  const source = readFileSync(path.join(root, 'integrations/skills/navis/SKILL.md'), 'utf8');
  const destination = path.join(directory, 'SKILL.md');
  if (existsSync(destination) && !/^name: navis\r?$/mu.test(readFileSync(destination, 'utf8')))
    throw new Error('The destination contains another skill');
  privateDir(directory);
  writeClientSkill(directory, source, bin);
  process.stdout.write(`Navis skill installed: ${directory}\n`);
}
async function encryptStream(input, destination) {
  if (existsSync(destination)) throw new Error('Backup destination already exists');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', backupKey(true), iv);
  const partial = `${destination}.partial`;
  const output = createWriteStream(partial, { flags: 'wx', mode: 0o600 });
  output.write(Buffer.concat([magic, iv]));
  try {
    await pipeline(input, cipher, output);
    appendFileSync(partial, cipher.getAuthTag());
    renameSync(partial, destination);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}
function decrypted(file) {
  const size = statSync(file).size;
  if (size < magic.length + 28) throw new Error('Invalid backup envelope');
  const fd = openSync(file, 'r');
  let header;
  let tag;
  try {
    header = Buffer.alloc(magic.length + 12);
    tag = Buffer.alloc(16);
    readSync(fd, header, 0, header.length, 0);
    readSync(fd, tag, 0, 16, size - 16);
  } finally {
    closeSync(fd);
  }
  if (!header.subarray(0, magic.length).equals(magic)) throw new Error('Unsupported backup format');
  const decipher = createDecipheriv('aes-256-gcm', backupKey(), header.subarray(magic.length));
  decipher.setAuthTag(tag);
  return { input: createReadStream(file, { start: header.length, end: size - 17 }), decipher };
}
async function backup() {
  privateDir(path.join(local, 'backups'));
  const file = path.join(
    local,
    'backups',
    `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${randomBytes(8).toString('hex')}.dump.enc`,
  );
  const child = spawn(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      '--user',
      'postgres',
      'postgres',
      'pg_dump',
      '-U',
      'navis',
      '-d',
      'navis',
      '--format=custom',
      '--no-owner',
      '--no-acl',
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = waitExit(child);
  try {
    await Promise.all([encryptStream(child.stdout, file), exited]);
    process.stdout.write(`${file}\n`);
  } catch (error) {
    child.kill('SIGTERM');
    rmSync(file, { force: true });
    throw error;
  }
}
async function restoreCheck(file) {
  if (Boolean(values['credential-file']) !== Boolean(values['snapshot-file']))
    throw new Error(
      'Supply both --credential-file and --snapshot-file for authenticated state verification',
    );
  const source = path.resolve(file);
  const proof = decrypted(source);
  await pipeline(
    proof.input,
    proof.decipher,
    new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  );
  const name = `navis-restore-${process.pid}`;
  const image = captured('docker', [...compose, 'config', '--images'])
    .trim()
    .split('\n')
    .find((value) => value.startsWith('postgres:'));
  if (!image) throw new Error('PostgreSQL image is missing');
  const password = randomBytes(32).toString('base64url');
  captured(
    'docker',
    [
      'run',
      '--rm',
      '-d',
      '--name',
      name,
      '--network',
      'none',
      '-e',
      'POSTGRES_USER=restore_test',
      '-e',
      'POSTGRES_DB=restore_db',
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      'POSTGRES_PASSWORD_FILE=',
      '--entrypoint',
      '/usr/local/bin/docker-entrypoint.sh',
      image,
      'postgres',
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: password } },
  );
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      const result = spawnSync(
        'docker',
        ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'restore_test', '-d', 'restore_db'],
        { stdio: 'ignore' },
      );
      if (result.status === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Restore database did not become ready');
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        name,
        'pg_restore',
        '-U',
        'restore_test',
        '-d',
        'restore_db',
        '--single-transaction',
        '--no-owner',
        '--no-acl',
      ],
      { stdio: ['pipe', 'ignore', 'inherit'] },
    );
    const restored = decrypted(source);
    await Promise.all([pipeline(restored.input, restored.decipher, child.stdin), waitExit(child)]);
    const counts = captured('docker', [
      'exec',
      name,
      'psql',
      '-U',
      'restore_test',
      '-d',
      'restore_db',
      '-Atc',
      "SELECT json_build_object('projects',(SELECT count(*) FROM projects),'events',(SELECT count(*) FROM project_events),'devices',(SELECT count(*) FROM devices))",
    ]);
    process.stdout.write(`Independent authenticated backup restore passed: ${counts.trim()}\n`);
    if (values['credential-file'] && values['snapshot-file']) {
      const apiImage = captured('docker', [...compose, 'config', '--images'])
        .trim()
        .split('\n')
        .find((value) => !value.startsWith('postgres:'));
      if (!apiImage) throw new Error('API image is missing');
      const verify = `
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createApiRuntime } from './dist/platform/composition.js';
import { loadApiConfig } from './dist/platform/config.js';
const credential = JSON.parse(readFileSync('/verify/credential.json', 'utf8'));
const expected = JSON.parse(readFileSync('/verify/snapshot.json', 'utf8'));
const runtime = await createApiRuntime({ ...loadApiConfig({ DATABASE_URL: process.env.NAVIS_RESTORE_DATABASE_URL }), port: 0 }, { write() {} });
try {
  const port = await runtime.listen();
  const response = await fetch('http://127.0.0.1:' + port + '/api/projects/' + expected.project_id + '/snapshot', { headers: { authorization: 'Bearer ' + credential.key_id + '.' + credential.key_secret } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, expected);
  process.stdout.write('Authenticated project projection and ledger cursor match the source snapshot.\\n');
} finally { await runtime.close(); }
`;
      run(
        'docker',
        [
          'run',
          '--rm',
          '-i',
          '--entrypoint',
          'node',
          '--network',
          `container:${name}`,
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges:true',
          '--mount',
          `type=bind,source=${path.resolve(values['credential-file'])},target=/verify/credential.json,readonly`,
          '--mount',
          `type=bind,source=${path.resolve(values['snapshot-file'])},target=/verify/snapshot.json,readonly`,
          '--user',
          `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`,
          '-e',
          'NAVIS_RESTORE_DATABASE_URL',
          apiImage,
          '--input-type=module',
        ],
        {
          input: verify,
          stdio: ['pipe', 'inherit', 'inherit'],
          env: {
            ...process.env,
            NAVIS_RESTORE_DATABASE_URL: `postgres://restore_test:${password}@127.0.0.1:5432/restore_db`,
          },
        },
      );
    }
  } finally {
    run('docker', ['stop', name], { stdio: 'ignore' });
  }
}
try {
  switch (command) {
    case 'setup':
      configure();
      break;
    case 'up':
      run('docker', [...compose, 'up', '-d', '--build']);
      break;
    case 'status':
      run('docker', [...compose, 'ps']);
      break;
    case 'restart':
      run('docker', [...compose, 'restart', 'api']);
      break;
    case 'provision':
      provision();
      break;
    case 'install-client':
      installClient();
      break;
    case 'install-skill':
      installSkill();
      break;
    case 'backup':
      await backup();
      break;
    case 'restore-check':
      if (!positionals[1]) throw new Error('Supply an encrypted backup path');
      await restoreCheck(positionals[1]);
      break;
    case 'encrypt-backup':
      if (!positionals[1]) throw new Error('Supply a private dump path');
      await encryptStream(createReadStream(positionals[1]), `${positionals[1]}.enc`);
      break;
    default:
      throw new Error(
        'Use setup, up, status, restart, provision, install-client, install-skill, backup or restore-check',
      );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Local instance operation failed'}\n`,
  );
  process.exitCode = 1;
}
