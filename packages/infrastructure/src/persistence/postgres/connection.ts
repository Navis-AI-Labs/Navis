import postgres from 'postgres';

/** Default resource bounds for connections owned by this adapter. */
export const POOL_MAX = 50;
export const POOL_IDLE_TIMEOUT = 20; // seconds
export const POOL_MAX_LIFETIME = 5 * 60; // seconds

/**
 * PostgreSQL 15+ connection factory. Managed PostgreSQL endpoints use the
 * same driver; other SQL engines require their own persistence adapters.
 */
export function createConnection(databaseUrl: string): postgres.Sql {
  return postgres(databaseUrl, {
    max: POOL_MAX,
    // Driver notices are not application telemetry or operator-command output.
    onnotice: () => undefined,
    connect_timeout: 5,
    connection: { statement_timeout: 15_000 },
    idle_timeout: POOL_IDLE_TIMEOUT,
    max_lifetime: POOL_MAX_LIFETIME,
  });
}

/**
 * Applies SQL files in filename order. Retries are idempotent; a changed
 * checksum fails the transaction instead of silently rewriting history.
 */
export async function runMigrations(sql: postgres.Sql): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const dir = path.join(import.meta.dirname, 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  await sql.begin(async (tx) => {
    // Concurrent application/test bootstraps must not race on catalog DDL.
    await tx`SELECT pg_advisory_xact_lock(hashtext('navis-schema-migrations'))`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const applied = new Map(
      (await tx`SELECT version, checksum FROM schema_migrations`).map((row) => [
        String(row['version']),
        String(row['checksum']),
      ]),
    );
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const statements = fs.readFileSync(path.join(dir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(statements).digest('hex');
      const seen = applied.get(version);
      if (seen !== undefined) {
        if (seen !== checksum)
          throw new Error(
            'migration ' + version + ' changed after it was applied (checksum mismatch)',
          );
        continue;
      }
      await tx.unsafe(statements);
      await tx`INSERT INTO schema_migrations (version, checksum) VALUES (${version}, ${checksum})`;
    }
  });
}

/** A readiness query has a shorter deadline than ordinary database operations. */
export async function probeConnection(sql: postgres.Sql, timeoutMs = 1500): Promise<void> {
  const query = sql`SELECT 1`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      query,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          query.cancel();
          reject(new Error('database readiness deadline exceeded'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
