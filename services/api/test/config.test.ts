import { describe, expect, it } from 'vitest';

import { InvalidApiConfigError, loadApiConfig } from '../src/platform/config.js';

describe('loadApiConfig', () => {
  it('applies every default when the environment is empty', () => {
    const config = loadApiConfig({});
    expect(config).toEqual({
      port: 8080,
      host: '127.0.0.1',
      log_level: 'info',
      log_redaction_allowlist: ['method', 'path', 'status', 'duration_ms'],
      max_body_bytes: 8_388_608,
      shutdown_timeout_ms: 30_000,
    });
  });

  it('reads and converts every value from the environment', () => {
    const config = loadApiConfig({
      NAVIS_API_PORT: '9090',
      NAVIS_API_HOST: '0.0.0.0',
      NAVIS_API_LOG_LEVEL: 'debug',
      NAVIS_API_LOG_REDACTION_ALLOWLIST: 'method, device_id ,, status',
      NAVIS_API_MAX_BODY_BYTES: '1024',
      NAVIS_API_SHUTDOWN_TIMEOUT_MS: '5000',
    });
    expect(config).toEqual({
      port: 9090,
      host: '0.0.0.0',
      log_level: 'debug',
      log_redaction_allowlist: ['method', 'device_id', 'status'],
      max_body_bytes: 1024,
      shutdown_timeout_ms: 5000,
    });
  });

  it('rejects a non-numeric port with a diagnostic naming the field', () => {
    expect(() => loadApiConfig({ NAVIS_API_PORT: 'not-a-port' })).toThrow(InvalidApiConfigError);
    expect(() => loadApiConfig({ NAVIS_API_PORT: 'not-a-port' })).toThrow(/port/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadApiConfig({ NAVIS_API_PORT: '70000' })).toThrow(InvalidApiConfigError);
  });

  it('rejects an unsupported log level', () => {
    expect(() => loadApiConfig({ NAVIS_API_LOG_LEVEL: 'verbose' })).toThrow(InvalidApiConfigError);
  });

  it('reports every failing field at once', () => {
    expect(() => loadApiConfig({ NAVIS_API_PORT: 'x', NAVIS_API_MAX_BODY_BYTES: 'y' })).toThrow(
      /port.*max_body_bytes|max_body_bytes.*port/s,
    );
  });
  it.each(['', 'not-a-url', 'https://example.invalid/db'])(
    'rejects invalid DATABASE_URL: %j',
    (databaseUrl) => {
      expect(() => loadApiConfig({ DATABASE_URL: databaseUrl })).toThrow(InvalidApiConfigError);
    },
  );

  it('retains an explicit PostgreSQL URL and never echoes an invalid secret', () => {
    const databaseUrl = 'postgres://test:test@127.0.0.1:5432/navis_test';
    expect(loadApiConfig({ DATABASE_URL: databaseUrl }).database_url).toBe(databaseUrl);
    try {
      loadApiConfig({ DATABASE_URL: 'invalid-test-secret' });
      expect.fail('invalid configuration was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidApiConfigError);
      expect(String(error)).not.toContain('invalid-test-secret');
    }
  });
});
