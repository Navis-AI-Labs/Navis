import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { resolveDaemonPaths, sendBridge, newRequestId } from '@navis/bridge-daemon';

const exec = promisify(execFile);
const cli =
  process.env['NAVIS_CLI_TEST_ENTRY'] ??
  fileURLToPath(new URL('../dist/process/index.js', import.meta.url));
const profiles: { dir: string; pid?: number }[] = [];
afterEach(async () => {
  for (const profile of profiles.splice(0)) {
    try {
      await sendBridge(
        { op: 'stop' },
        resolveDaemonPaths({ env: { ...process.env, NAVIS_HOME: profile.dir } }).socketPath,
      );
    } catch {
      /* A killed process has no listener to stop. */
    }
    for (let attempt = 0; profile.pid !== undefined && attempt < 100; attempt++) {
      try {
        process.kill(profile.pid, 0);
      } catch {
        break;
      }
      await delay(20);
    }
    rmSync(profile.dir, { recursive: true, force: true });
  }
});
function profile() {
  const value: { dir: string; pid?: number } = {
    dir: mkdtempSync(path.join(tmpdir(), 'navis profile ')),
  };
  profiles.push(value);
  return value;
}
async function invoke(home: string, args: string[]): Promise<Record<string, unknown>> {
  const result = await exec(process.execPath, [cli, ...args], {
    env: { ...process.env, NAVIS_HOME: home },
    timeout: 30000,
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
it('uses independent native daemons for human and agent profiles and converges concurrent callers', async () => {
  const human = profile(),
    agent = profile();
  const [humans, agents] = await Promise.all(
    [human, agent].map((p) =>
      Promise.all(Array.from({ length: 3 }, () => invoke(p.dir, ['status']))),
    ),
  );
  if (!humans || !agents) throw new Error('profile results missing');
  human.pid = Number(humans[0]?.['pid']);
  agent.pid = Number(agents[0]?.['pid']);
  expect(new Set(humans.map((s) => s['pid'])).size).toBe(1);
  expect(new Set(agents.map((s) => s['pid'])).size).toBe(1);
  expect(human.pid).not.toBe(agent.pid);
  expect(humans[0]?.['configured']).toBe(false);
});
it('authenticates with a private file, refuses exposed credentials and recovers configuration after process death', async () => {
  const p = profile();
  p.pid = Number((await invoke(p.dir, ['status']))['pid']);
  const credential = {
    participant_id: newRequestId(),
    participant_type: 'agent',
    device_id: newRequestId(),
    key_id: newRequestId(),
    key_secret: 'synthetic-native-device-secret-0001',
    issued_at: '2026-10-11T00:00:00.000Z',
  };
  const file = path.join(p.dir, 'device.json');
  writeFileSync(file, JSON.stringify(credential), { mode: 0o600 });
  let authenticated = 0;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${credential.key_id}.${credential.key_secret}`) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    authenticated++;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        data: {
          participant_id: credential.participant_id,
          device_id: credential.device_id,
          devices: [],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listener missing');
  const args = [
    'configure',
    '--remote',
    `http://127.0.0.1:${String(address.port)}`,
    '--credential-file',
    file,
  ];
  try {
    expect((await invoke(p.dir, args))['device_id']).toBe(credential.device_id);
    expect(authenticated).toBe(1);
    if (process.platform === 'win32') {
      await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$acl = Get-Acl -LiteralPath $env:NAVIS_TEST_KEY; $rule = [System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:NAVIS_TEST_KEY -AclObject $acl",
        ],
        { env: { ...process.env, NAVIS_TEST_KEY: file } },
      );
    } else chmodSync(file, 0o644);
    await expect(invoke(p.dir, args)).rejects.toThrow();
    expect(authenticated).toBe(1);
    unlinkSync(file);
    writeFileSync(file, JSON.stringify(credential), { mode: 0o600 });
    process.kill(p.pid, 'SIGKILL');
    await delay(150);
    const recovered = await invoke(p.dir, ['status']);
    expect(recovered['pid']).not.toBe(p.pid);
    p.pid = Number(recovered['pid']);
    expect(recovered['configured']).toBe(true);
    expect((await invoke(p.dir, args))['device_id']).toBe(credential.device_id);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});
