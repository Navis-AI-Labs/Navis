import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('reports a process startup failure without dumping configuration values or stacks', async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        name !== 'DATABASE_URL' && name !== 'DATABASE_URL_FILE' && !name.startsWith('NAVIS_MODEL_'),
    ),
  );
  const marker = 'synthetic-private-startup-value';
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../dist/platform/index.js', import.meta.url))],
    {
      env: { ...env, DATABASE_URL: `https://user:${marker}@invalid.example/database` },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  expect(exit).toBe(1);
  expect(JSON.parse(stdout.trim())).toMatchObject({
    level: 'error',
    message: 'API startup failed',
  });
  expect(stdout + stderr).not.toContain(marker);
  expect(stderr).toBe('');
});
