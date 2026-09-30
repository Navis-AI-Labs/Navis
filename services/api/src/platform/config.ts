import { z } from 'zod';

/**
 * Service configuration — the one place the environment is read.
 *
 * Every value is parsed and validated exactly once at startup (standard 12),
 * so request code handles a closed, typed object and never re-parses an
 * environment string. An invalid required value stops the process here with a
 * diagnostic naming every failing field: failing later, inside a request, is
 * not an option.
 */

/** Boundaries keep the service honest on a single host: machine clients only. */
const defaultPort = 8080;
const defaultHost = '127.0.0.1';
const defaultLogLevel = 'info';
const defaultMaxBodyBytes = 8_388_608;
const defaultShutdownTimeoutMs = 30_000;

/**
 * Field names a log line may carry verbatim. Everything else is masked by the
 * logger, so an operator widening telemetry is a deliberate config change.
 */
const defaultRedactionAllowlist = ['method', 'path', 'status', 'duration_ms'];

export const apiConfigSchema = z
  .strictObject({
    port: z.int().min(1).max(65_535),
    host: z.string().min(1).max(253),
    log_level: z.enum(['debug', 'info', 'warn', 'error']),
    log_redaction_allowlist: z.array(z.string().min(1).max(128)).max(64),
    max_body_bytes: z.int().min(1).max(104_857_600),
    shutdown_timeout_ms: z.int().min(1).max(300_000),
  })
  .meta({ description: 'API service startup configuration.', id: 'ApiConfig' });

export type ApiConfig = z.infer<typeof apiConfigSchema>;

/** Thrown at startup when the environment cannot produce a valid configuration. */
export class InvalidApiConfigError extends Error {
  override readonly name = 'InvalidApiConfigError' as const;
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`invalid api configuration: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

interface EnvSource {
  readonly port: string | undefined;
  readonly host: string | undefined;
  readonly logLevel: string | undefined;
  readonly allowlist: string | undefined;
  readonly maxBodyBytes: string | undefined;
  readonly shutdownTimeoutMs: string | undefined;
}

const envKeys = {
  port: 'NAVIS_API_PORT',
  host: 'NAVIS_API_HOST',
  logLevel: 'NAVIS_API_LOG_LEVEL',
  allowlist: 'NAVIS_API_LOG_REDACTION_ALLOWLIST',
  maxBodyBytes: 'NAVIS_API_MAX_BODY_BYTES',
  shutdownTimeoutMs: 'NAVIS_API_SHUTDOWN_TIMEOUT_MS',
} as const;

function readEnv(env: Record<string, string | undefined>): EnvSource {
  return {
    port: env[envKeys.port],
    host: env[envKeys.host],
    logLevel: env[envKeys.logLevel],
    allowlist: env[envKeys.allowlist],
    maxBodyBytes: env[envKeys.maxBodyBytes],
    shutdownTimeoutMs: env[envKeys.shutdownTimeoutMs],
  };
}

/** Comma-separated list: blanks and surrounding whitespace carry no meaning. */
function parseAllowlist(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Number conversion happens here, not in the schema: `NaN` from a non-numeric string then fails the integer check. */
function numberOr(raw: string | undefined, fallback: number): number {
  return raw === undefined ? fallback : Number(raw);
}

/**
 * Loads and validates configuration. Defaults are the self-hosted single-org
 * deployment; every override arrives through the environment.
 */
export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const source = readEnv(env);
  const parsed = apiConfigSchema.safeParse({
    port: numberOr(source.port, defaultPort),
    host: source.host ?? defaultHost,
    log_level: source.logLevel ?? defaultLogLevel,
    log_redaction_allowlist:
      source.allowlist === undefined ? defaultRedactionAllowlist : parseAllowlist(source.allowlist),
    max_body_bytes: numberOr(source.maxBodyBytes, defaultMaxBodyBytes),
    shutdown_timeout_ms: numberOr(source.shutdownTimeoutMs, defaultShutdownTimeoutMs),
  });
  if (!parsed.success) {
    throw new InvalidApiConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}
