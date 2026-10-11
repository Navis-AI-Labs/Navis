import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../src/platform/runtime-config.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'navis-config-'));
  dirs.push(dir);
  return dir;
}
const database = 'postgres://test:test@127.0.0.1:5432/navis_test';
describe('durable process configuration', () => {
  it('requires a database and accepts an explicit URL', async () => {
    await expect(loadRuntimeConfig({})).rejects.toThrow('database_url');
    expect((await loadRuntimeConfig({ DATABASE_URL: database })).database_url).toBe(database);
  });
  it('reads mounted secrets without retaining their file paths in configuration', async () => {
    const dir = fixture();
    const db = path.join(dir, 'database');
    const key = path.join(dir, 'model');
    writeFileSync(db, database + '\n');
    writeFileSync(key, 'test-provider-secret\n');
    const config = await loadRuntimeConfig({
      DATABASE_URL_FILE: db,
      NAVIS_MODEL_API_KEY_FILE: key,
      NAVIS_MODEL_BASE_URL: 'https://provider.invalid/v1',
      NAVIS_MODEL_NAME: 'model',
    });
    expect(config.database_url).toBe(database);
    expect(config.model?.key).toBe('test-provider-secret');
    expect(config).not.toHaveProperty('DATABASE_URL_FILE');
  });
  it('rejects ambiguous and unreadable database configuration', async () => {
    await expect(
      loadRuntimeConfig({ DATABASE_URL: database, DATABASE_URL_FILE: 'unused' }),
    ).rejects.toThrow('one database');
    await expect(
      loadRuntimeConfig({ DATABASE_URL_FILE: '/does-not-exist/navis-db' }),
    ).rejects.toThrow('unreadable');
  });
  it('rejects ambiguous or unreadable model credentials', async () => {
    await expect(
      loadRuntimeConfig({
        DATABASE_URL: database,
        NAVIS_MODEL_API_KEY_FILE: 'unused',
        NAVIS_MODEL_API_KEY: 'test-provider-secret',
      }),
    ).rejects.toThrow('one model');
    await expect(
      loadRuntimeConfig({
        DATABASE_URL: database,
        NAVIS_MODEL_API_KEY_FILE: '/does-not-exist/navis-model',
      }),
    ).rejects.toThrow('unreadable');
  });
  it('requires every provider setting when model generation is enabled', async () => {
    await expect(
      loadRuntimeConfig({ DATABASE_URL: database, NAVIS_MODEL_NAME: 'model' }),
    ).rejects.toThrow('model');
  });
});
