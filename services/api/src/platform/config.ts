import { z } from 'zod';

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
    database_url: z
      .url({ protocol: /^postgres(?:ql)?$/ })
      .max(2_048)
      .optional(),
  })
  .meta({
    description:
      'Validated API startup configuration; an absent database URL selects in-memory storage.',
    id: 'ApiConfig',
  });

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

/** Comma-separated list: blanks and surrounding whitespace carry no meaning. */
function parseAllowlist(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Preserve invalid numeric input as NaN so the startup schema rejects it. */
function numberOr(raw: string | undefined, fallback: number): number {
  return raw === undefined ? fallback : Number(raw);
}

/** Reads the environment once; invalid values produce field diagnostics without their contents. */
export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const parsed = apiConfigSchema.safeParse({
    port: numberOr(env['NAVIS_API_PORT'], defaultPort),
    host: env['NAVIS_API_HOST'] ?? defaultHost,
    log_level: env['NAVIS_API_LOG_LEVEL'] ?? defaultLogLevel,
    log_redaction_allowlist:
      env['NAVIS_API_LOG_REDACTION_ALLOWLIST'] === undefined
        ? defaultRedactionAllowlist
        : parseAllowlist(env['NAVIS_API_LOG_REDACTION_ALLOWLIST']),
    max_body_bytes: numberOr(env['NAVIS_API_MAX_BODY_BYTES'], defaultMaxBodyBytes),
    shutdown_timeout_ms: numberOr(env['NAVIS_API_SHUTDOWN_TIMEOUT_MS'], defaultShutdownTimeoutMs),
    database_url: env['DATABASE_URL'],
  });
  if (!parsed.success) {
    throw new InvalidApiConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}
