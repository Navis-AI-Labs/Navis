import children from 'node:child_process';
import fs, { mkdtempSync, chmodSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { checkWindowsAccess, ensurePrivateDirectory } from '../src/security/private-files.js';
import { readCredential } from '../src/remote/client.js';
import { uuidv7 } from '@navis/domain';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it('passes a literal path to native ACL validation and sanitizes failures', () => {
  const run = vi.spyOn(children, 'execFileSync').mockReturnValue(Buffer.alloc(0));
  checkWindowsAccess('check', 'C:\\private files\\device.json');
  expect(run.mock.calls[0]?.[1]).toContain('C:\\private files\\device.json');
  expect(run.mock.calls[0]?.[1]).toContain('-File');
  run.mockImplementation(() => {
    throw new Error('private native error');
  });
  expect(() => {
    checkWindowsAccess('check', 'C:\\secret');
  }).toThrow('access-control');
});
it('refuses insecure existing Unix directories and non-directory paths', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'navis-private-'));
  dirs.push(dir);
  ensurePrivateDirectory(dir);
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o755);
    expect(() => {
      ensurePrivateDirectory(dir);
    }).toThrow('owned');
    chmodSync(dir, 0o700);
  }
  const stat = vi.spyOn(fs, 'lstatSync');
  stat.mockReturnValueOnce({ isDirectory: () => false, isSymbolicLink: () => false } as ReturnType<
    typeof fs.lstatSync
  >);
  expect(() => {
    ensurePrivateDirectory(dir);
  }).toThrow('regular directory');
});
it('uses ACL protection when opening a Windows private state directory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'navis-acl-'));
  dirs.push(dir);
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!original) throw new Error('platform descriptor missing');
  const run = vi.spyOn(children, 'execFileSync').mockReturnValue(Buffer.alloc(0));
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try {
    mkdirSync(path.join(dir, 'state'));
    ensurePrivateDirectory(path.join(dir, 'state'));
    expect(run).toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});
it('checks native ACLs before returning a Windows credential', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'navis-credential-'));
  dirs.push(dir);
  const file = path.join(dir, 'device.json');
  writeFileSync(
    file,
    JSON.stringify({
      participant_id: uuidv7(),
      participant_type: 'agent',
      device_id: uuidv7(),
      key_id: uuidv7(),
      key_secret: 'x'.repeat(32),
      issued_at: '2026-10-11T00:00:00.000Z',
    }),
    { mode: 0o600 },
  );
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!original) throw new Error('platform descriptor missing');
  const run = vi.spyOn(children, 'execFileSync').mockReturnValue(Buffer.alloc(0));
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try {
    expect((await readCredential(file)).participant_type).toBe('agent');
    expect(run.mock.calls[0]?.[1]).toContain('check');
    run.mockImplementationOnce(() => {
      throw new Error('exposed ACL');
    });
    await expect(readCredential(file)).rejects.toThrow('access-control');
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});
