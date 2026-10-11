import { readFile } from 'node:fs/promises';
import { InvalidApiConfigError, loadApiConfig, type ApiConfig } from './config.js';

/** The executable service requires durable storage; only injected test runtimes use memory. */
export async function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<ApiConfig> {
  const values = { ...env };
  if (env['DATABASE_URL_FILE'] !== undefined) {
    if (env['DATABASE_URL'] !== undefined)
      throw new InvalidApiConfigError(['provide one database configuration source']);
    try {
      values['DATABASE_URL'] = (await readFile(env['DATABASE_URL_FILE'], 'utf8')).trim();
    } catch {
      throw new InvalidApiConfigError(['database configuration file is unreadable']);
    }
  }
  if (env['NAVIS_MODEL_API_KEY_FILE'] !== undefined) {
    if (env['NAVIS_MODEL_API_KEY'] !== undefined)
      throw new InvalidApiConfigError(['provide one model credential source']);
    try {
      values['NAVIS_MODEL_API_KEY'] = (
        await readFile(env['NAVIS_MODEL_API_KEY_FILE'], 'utf8')
      ).trim();
    } catch {
      throw new InvalidApiConfigError(['model credential file is unreadable']);
    }
  }
  const config = loadApiConfig(values);
  if (config.database_url === undefined)
    throw new InvalidApiConfigError(['database_url is required for the service process']);
  return config;
}
