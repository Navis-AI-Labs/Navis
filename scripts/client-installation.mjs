import process from 'node:process';
import path from 'node:path';
import { writeFileSync, chmodSync } from 'node:fs';

/** pnpm supplies its JS entry when invoking an instance script, including on Windows. */
export function pnpmInvocation(
  args,
  env = process.env,
  platform = process.platform,
  node = process.execPath,
) {
  const entry = env.npm_execpath;
  if (entry && /pnpm\.(?:cjs|mjs|js)$/u.test(entry))
    return { program: node, args: [entry, ...args] };
  if (entry && platform === 'win32' && /(?:^|[\\/])pnpm\.exe$/iu.test(entry))
    return { program: entry, args };
  if (platform === 'win32')
    throw new Error(
      'Run installation with pnpm instance install-client so the package-manager entry is available.',
    );
  return { program: 'pnpm', args };
}

/** Generated launchers belong to this installation; none are committed or shipped between machines. */
export function writeClientLaunchers(bin, platform = process.platform, node = process.execPath) {
  writeFileSync(
    path.join(bin, 'navis-entry.mjs'),
    `import process from 'node:process';
import path from 'node:path';
import { homedir } from 'node:os';
if (!process.env.NAVIS_HOME) process.env.NAVIS_HOME = path.join(homedir(), '.navis', 'runtime');
await import('../client/dist/process/index.js');
`,
    { mode: 0o600 },
  );
  if (platform === 'win32') {
    const literal = `'${node.replaceAll("'", "''")}'`;
    // PowerShell 5.1 needs a BOM to decode non-ASCII executable paths as UTF-8.
    writeFileSync(
      path.join(bin, 'navis.ps1'),
      `\uFEFF& ${literal} (Join-Path $PSScriptRoot 'navis-entry.mjs') @args\r\nexit $LASTEXITCODE\r\n`,
    );
    // Keep CMD source ASCII; the PowerShell file owns the host's executable path.
    writeFileSync(
      path.join(bin, 'navis.cmd'),
      `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0navis.ps1" %*\r\nexit /b %errorlevel%\r\n`,
    );
    return;
  }
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = path.join(bin, 'navis');
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec ${quote(node)} ${quote(path.join(bin, 'navis-entry.mjs'))} "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(launcher, 0o755);
}

/** Only the installed skill records this machine's pinned runtime and client entry. */
export function writeClientSkill(
  directory,
  source,
  bin,
  platform = process.platform,
  node = process.execPath,
) {
  const quote = (value) =>
    platform === 'win32'
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${platform === 'win32' ? '& ' : ''}${quote(node)} ${quote(path.join(bin, 'navis-entry.mjs'))}`;
  writeFileSync(
    path.join(directory, 'SKILL.md'),
    `${source.trimEnd()}\n\n## Installed client\n\nUse this installation's command in place of \`navis\` in the examples. Run it from the consuming project's directory; append the operation and arguments. This generated location belongs only to this installed copy.\n\n\`\`\`${platform === 'win32' ? 'powershell' : 'sh'}\n${command}\n\`\`\`\n`,
    { mode: 0o600 },
  );
}
