import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Windows mode bits do not enforce privacy; use the native ACL policy shipped with this package. */
export function checkWindowsAccess(action: 'protect-directory' | 'check', target: string): void {
  try {
    childProcess.execFileSync(
      path.win32.join(
        process.env['SystemRoot'] ?? 'C:\\Windows',
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
        fileURLToPath(new URL('./windows-access.ps1', import.meta.url)),
        '-Action',
        action,
        '-LiteralPath',
        target,
      ],
      { stdio: 'pipe', windowsHide: true, timeout: 10_000 },
    );
  } catch (cause) {
    throw new Error('private state access-control validation failed', { cause });
  }
}

/** Private directories also protect SQLite side files and newly created credentials. */
export function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('private state requires a regular directory');
  if (process.platform === 'win32') checkWindowsAccess('protect-directory', directory);
  else if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error('private state directory must be owned by the current user');
}
