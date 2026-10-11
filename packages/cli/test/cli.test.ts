import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeRequest } from '@navis/bridge-daemon';
import { parse, run, type CliDeps } from '../src/index.js';
const PROJECT = '01924a61-7a1b-7c2d-8e3f-000000000001';
const PERSON = '01924a61-7a1b-7c2d-8e3f-000000000002';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'navis-cli-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'navis.toml'), `project_id = "${PROJECT}"\n`);
  const requests: BridgeRequest[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const deps: CliDeps = {
    cwd: () => dir,
    send: (request) => {
      requests.push(request);
      return Promise.resolve({ ok: true });
    },
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
  };
  return { dir, requests, output, errors, deps };
}
describe('CLI operation boundary', () => {
  it.each([{ args: [] }, { args: ['--help'] }])(
    'help does not start a daemon: %j',
    async ({ args }) => {
      const f = fixture();
      expect(await run(args, f.deps)).toBe(0);
      expect(f.requests).toEqual([]);
      expect(f.output[0]).toContain('configure');
    },
  );
  it('passes connection location without copying credentials into the request', async () => {
    const f = fixture();
    expect(
      await run(
        ['configure', '--remote', 'http://127.0.0.1:8080', '--credential-file', 'device.json'],
        f.deps,
      ),
    ).toBe(0);
    expect(f.requests[0]).toEqual({
      op: 'configure',
      remote: 'http://127.0.0.1:8080',
      credential_file: path.join(f.dir, 'device.json'),
    });
  });
  it('creates stable explicit project and command identities', async () => {
    const f = fixture();
    expect(
      await run(
        ['init', '--name', 'experiment', '--id', PROJECT, '--request-id', 'create-once'],
        f.deps,
      ),
    ).toBe(0);
    expect(f.requests[0]).toEqual({
      op: 'project.create',
      request: { project_id: PROJECT, title: 'experiment' },
      key: 'create-once',
      cwd: f.dir,
    });
  });
  it('generates valid ids when not supplied', async () => {
    const f = fixture();
    expect(await run(['init', '--name', 'experiment'], f.deps)).toBe(0);
    expect(JSON.stringify(f.requests[0])).toMatch(/-7[0-9a-f]{3}-/u);
  });
  it.each(['status', 'sync', 'stop'])('delegates %s', async (command) => {
    const f = fixture();
    expect(await run([command], f.deps)).toBe(0);
    expect(f.requests).toEqual([{ op: command }]);
  });
  it('resolves state from the declaration unless explicitly overridden', async () => {
    const f = fixture();
    await run(['state'], f.deps);
    await run(['state', '--project', PERSON], f.deps);
    expect(f.requests).toEqual([
      { op: 'project.state', project_id: PROJECT },
      { op: 'project.state', project_id: PERSON },
    ]);
  });
  it('rejects forged actor fields before sending a command', async () => {
    const f = fixture();
    writeFileSync(
      path.join(f.dir, 'command.json'),
      JSON.stringify({
        type: 'work.create',
        title: 'work',
        reason: 'test',
        expected_version: 0,
        actor: PERSON,
      }),
    );
    expect(await run(['command', '--file', 'command.json'], f.deps)).toBe(1);
    expect(f.requests).toEqual([]);
  });
  it.each(['', '\uFEFF'])(
    'sends UTF-8 command JSON with its idempotency key (BOM %j)',
    async (bom) => {
      const f = fixture();
      const command = { type: 'work.create', title: 'work', reason: 'test', expected_version: 0 };
      writeFileSync(path.join(f.dir, 'command.json'), bom + JSON.stringify(command));
      expect(await run(['command', '--file', 'command.json', '--request-id', 'once'], f.deps)).toBe(
        0,
      );
      expect(f.requests[0]).toEqual({
        op: 'project.command',
        project_id: PROJECT,
        command,
        key: 'once',
      });
    },
  );
  it.each(['grant', 'revoke'])('requests membership %s', async (action) => {
    const f = fixture();
    expect(await run(['member', '--participant', PERSON, '--action', action], f.deps)).toBe(0);
    expect(f.requests[0]).toMatchObject({
      op: 'project.member',
      request: { participant_id: PERSON, action },
    });
  });
  it('defaults membership to grant', async () => {
    const f = fixture();
    expect(await run(['member', '--participant', PERSON], f.deps)).toBe(0);
    expect(f.requests[0]).toMatchObject({ request: { action: 'grant' } });
  });
  it.each([false, true])('captures with explicit local-only policy: %s', async (local) => {
    const f = fixture();
    writeFileSync(
      path.join(f.dir, 'step.json'),
      JSON.stringify({ kind: 'user.message', body: 'private source' }),
    );
    expect(
      await run(
        [
          'capture',
          '--file',
          'step.json',
          ...(local ? ['--local-only', '--session', 'session-a'] : []),
        ],
        f.deps,
      ),
    ).toBe(0);
    expect(f.requests[0]).toMatchObject({
      op: 'capture',
      privacy: local ? 'local-only' : 'metadata',
      session_id: local ? 'session-a' : 'manual',
    });
  });
  it('sends hook identity for repeat detection', async () => {
    const f = fixture();
    expect(await run(['hook', '--request-id', PERSON], f.deps)).toBe(0);
    expect(f.requests[0]).toEqual({ op: 'hook.session.start', request_id: PERSON, cwd: f.dir });
  });
  it('submits assistance and polls by job id', async () => {
    const f = fixture();
    writeFileSync(
      path.join(f.dir, 'assist.json'),
      JSON.stringify({ prompt: 'propose a plan', expected_version: 0 }),
    );
    expect(await run(['assist', '--file', 'assist.json'], f.deps)).toBe(0);
    expect(await run(['assist-status', '--job', PERSON], f.deps)).toBe(0);
    expect(f.requests[1]).toMatchObject({ op: 'assistance.status', job_id: PERSON });
  });
  it.each([
    { args: ['unknown'] },
    { args: ['status', 'extra'] },
    { args: ['command'] },
    { args: ['configure'] },
    { args: ['status', '--key', 'never-on-command-line'] },
  ])('invalid invocation does not reach Bridge: %j', async ({ args }) => {
    const f = fixture();
    expect(await run(args, f.deps)).toBe(1);
    expect(f.requests).toEqual([]);
    expect(f.errors.length).toBe(1);
  });
  it('bounds input files', async () => {
    const f = fixture();
    writeFileSync(path.join(f.dir, 'large.json'), ' '.repeat(262145));
    expect(await run(['command', '--file', 'large.json'], f.deps)).toBe(1);
    expect(f.errors[0]).toContain('256 KiB');
  });
  it('reports Bridge failures and malformed input without success output', async () => {
    const f = fixture();
    expect(
      await run(['state'], { ...f.deps, send: () => Promise.reject(new Error('offline')) }),
    ).toBe(1);
    expect(f.errors).toEqual(['offline']);
    expect(f.output).toEqual([]);
  });
  it('handles non-Error adapter failures', async () => {
    const f = fixture();
    expect(
      await run(['state'], {
        ...f.deps,
        send: () => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercise an untyped adapter failure
          return Promise.reject('offline');
        },
      }),
    ).toBe(1);
    expect(f.errors).toEqual(['CLI operation failed']);
  });
  it('parses flags without inventing additional positionals', () => {
    expect(parse(['init', '--name=project']).positionals).toEqual(['init']);
  });
  it('requests paged history and project search without constructing opaque cursors', async () => {
    const f = fixture();
    expect(
      await run(
        [
          'history',
          '--types',
          'work,session',
          '--limit',
          '5',
          '--cursor',
          'opaque',
          '--from',
          '2026-01-01T00:00:00.000Z',
          '--to',
          '2027-01-01T00:00:00.000Z',
        ],
        f.deps,
      ),
    ).toBe(0);
    expect(f.requests[0]).toMatchObject({
      op: 'project.context',
      request: { cursor: 'opaque', limit: 5, filter: { types: ['work', 'session'] } },
    });
    expect(
      await run(['projects', '--query', 'project', '--cursor', 'opaque', '--limit', '5'], f.deps),
    ).toBe(0);
    expect(await run(['projects'], f.deps)).toBe(0);
    expect(await run(['history'], f.deps)).toBe(0);
  });
});
