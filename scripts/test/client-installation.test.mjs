import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  linkSync,
  symlinkSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pnpmInvocation, writeClientLaunchers, writeClientSkill } from '../client-installation.mjs';
import { isolateDeploymentFiles } from '../package-deployment.mjs';

function fixture(t, platform = process.platform) {
  const root = mkdtempSync(path.join(tmpdir(), "navis 客户端 ' "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const target = path.join(root, 'client/dist/process');
  mkdirSync(bin);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(root, 'client/package.json'), '{"type":"module"}');
  writeFileSync(
    path.join(target, 'index.js'),
    `process.stdout.write(JSON.stringify({args:process.argv.slice(2),home:process.env.NAVIS_HOME}));`,
  );
  writeClientLaunchers(bin, platform);
  return { root, bin };
}
test('uses the package manager JS entry without a Windows command shell', () => {
  const entry = 'C:\\Tools with spaces\\pnpm.cjs';
  assert.deepEqual(pnpmInvocation(['deploy'], { npm_execpath: entry }, 'win32', 'node.exe'), {
    program: 'node.exe',
    args: [entry, 'deploy'],
  });
  assert.throws(() => pnpmInvocation([], {}, 'win32'), /pnpm instance/);
  assert.deepEqual(pnpmInvocation(['deploy'], { npm_execpath: 'C:\\Tools\\pnpm.exe' }, 'win32'), {
    program: 'C:\\Tools\\pnpm.exe',
    args: ['deploy'],
  });
  assert.deepEqual(pnpmInvocation(['build'], {}, 'linux'), { program: 'pnpm', args: ['build'] });
});
test('generates Windows launchers and a common entry without a developer profile path', (t) => {
  const f = fixture(t, 'win32');
  writeClientLaunchers(f.bin, 'win32', "C:\\运行 工具 ' % ! &\\node.exe");
  const cmd = readFileSync(path.join(f.bin, 'navis.cmd'), 'utf8');
  assert([...cmd].every((character) => character.charCodeAt(0) <= 0x7f));
  assert(cmd.includes('navis.ps1'));
  assert.equal(readFileSync(path.join(f.bin, 'navis.ps1'))[0], 0xef);
  assert.match(readFileSync(path.join(f.bin, 'navis.cmd'), 'utf8'), /DisableDelayedExpansion/);
  assert.match(readFileSync(path.join(f.bin, 'navis.ps1'), 'utf8'), /PSScriptRoot/);
  const entry = readFileSync(path.join(f.bin, 'navis-entry.mjs'), 'utf8');
  assert(!entry.includes(f.root));
  assert(!entry.includes(process.execPath));
});
test('native launchers preserve arguments and an explicit profile in a directory with spaces', (t) => {
  const f = fixture(t);
  if (process.platform === 'win32') {
    const tools = path.join(f.root, "运行 tools ' % ! &");
    mkdirSync(tools);
    const node = path.join(tools, 'node.exe');
    copyFileSync(process.execPath, node);
    writeClientLaunchers(f.bin, 'win32', node);
  }
  const home = path.join(f.root, 'profile with spaces');
  const args = ['--name', 'Project & example', '--file', path.join(f.root, 'input file.json')];
  const invoke =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(f.bin, 'navis.ps1'),
            ...args,
          ],
        ]
      : [path.join(f.bin, 'navis'), args];
  const output = execFileSync(invoke[0], invoke[1], {
    env: { ...process.env, NAVIS_HOME: home },
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(output), { args, home });
  if (process.platform === 'win32') {
    const fromCmd = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "& $env:NAVIS_TEST_LAUNCHER --name 'Project & example' --file $env:NAVIS_TEST_FILE; exit $LASTEXITCODE",
      ],
      {
        env: {
          ...process.env,
          NAVIS_HOME: home,
          NAVIS_TEST_LAUNCHER: path.join(f.bin, 'navis.cmd'),
          NAVIS_TEST_FILE: args[3],
        },
        encoding: 'utf8',
      },
    );
    assert.deepEqual(JSON.parse(fromCmd), { args, home });
  }
  const defaultOutput = execFileSync(process.execPath, [path.join(f.bin, 'navis-entry.mjs')], {
    env: { ...process.env, NAVIS_HOME: '' },
    encoding: 'utf8',
  });
  assert(JSON.parse(defaultOutput).home.endsWith(path.join('.navis', 'runtime')));
});

test('an installed skill invokes the pinned client from another project directory', (t) => {
  const f = fixture(t);
  const skill = path.join(f.root, 'skill');
  mkdirSync(skill);
  writeClientSkill(skill, '---\nname: navis\ndescription: Test\n---\n', f.bin);
  const document = readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
  const command = /```(?:sh|powershell)\n([^\n]+)\n```/u.exec(document)?.[1];
  assert(command);
  const home = path.join(f.root, 'agent');
  const invocation =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${command} status`]]
      : ['/bin/sh', ['-c', `${command} status`]];
  const output = execFileSync(invocation[0], invocation[1], {
    cwd: skill,
    env: { ...process.env, NAVIS_HOME: home },
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(output), { args: ['status'], home });
  writeClientSkill(
    skill,
    '---\nname: navis\ndescription: Test\n---\n',
    f.bin,
    'win32',
    "C:\\Tools ' space\\node.exe",
  );
  assert(
    readFileSync(path.join(skill, 'SKILL.md'), 'utf8').includes("& 'C:\\Tools '' space\\node.exe'"),
  );
});

test('installed runtime bytes remain independent of workspace rebuilds', (t) => {
  const f = fixture(t);
  const original = path.join(f.root, 'workspace.js');
  const deployed = path.join(f.root, 'client/deployed.js');
  writeFileSync(original, 'export const revision = 1;');
  linkSync(original, deployed);
  isolateDeploymentFiles(path.join(f.root, 'client'));
  writeFileSync(original, 'export const revision = 2;');
  assert.equal(readFileSync(deployed, 'utf8'), 'export const revision = 1;');
});
test('deployment refuses symbolic links outside its installed directory', (t) => {
  const f = fixture(t);
  symlinkSync(f.bin, path.join(f.root, 'client/external'), 'junction');
  assert.throws(
    () => isolateDeploymentFiles(path.join(f.root, 'client')),
    /external symbolic link/,
  );
});

for (const name of ['cli', 'api'])
  test(`the ${name} package self-reference stays inside its deployment`, (t) => {
    const f = fixture(t);
    const root = path.join(f.root, 'client');
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: `@navis/${name}`, type: 'module' }),
    );
    const scope = path.join(root, 'node_modules/.pnpm/node_modules/@navis');
    mkdirSync(scope, { recursive: true });
    symlinkSync(f.bin, path.join(scope, name), 'junction');
    isolateDeploymentFiles(root);
    assert.equal(
      readFileSync(path.join(scope, name, 'package.json'), 'utf8'),
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
  });
