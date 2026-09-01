import postgres from 'postgres';

/** Production-baseline pool tuning, exposed as named constants. */
export const POOL_MAX = 50; // sized for control-plane traffic; the library default is 10
export const POOL_IDLE_TIMEOUT = 20; // seconds; below common LB idle cutoffs
export const POOL_MAX_LIFETIME = 5 * 60; // seconds; bounded connection churn

/**
 * Engine-neutral connection factory: any PostgreSQL 15+ wire endpoint
 * (Supabase, Neon, RDS, self-hosted, local Docker) is a DATABASE_URL away.
 * No platform SDK is involved.
 */
export function createConnection(databaseUrl: string): postgres.Sql {
  return postgres(databaseUrl, {
    max: POOL_MAX,
    idle_timeout: POOL_IDLE_TIMEOUT,
    max_lifetime: POOL_MAX_LIFETIME,
  });
}

/**
 * Applies pending migrations in order; idempotent — each file records its
 * version and SHA-256 checksum in schema_migrations and re-running is a
 * no-op (persistence-ports scenario: "migrations run twice → second run is
 * a no-op"). The migration list is derived from the migrations directory
 * (N prefix.sql, applied in filename order), so adding 002_x.sql never
 * requires editing this file.
 */
export async function runMigrations(sql: postgres.Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  // Checksum guard: editing an already-applied migration silently skips it on
  // migrated environments. Store the file hash and fail loudly on drift.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const dir = path.join(import.meta.dirname, 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = new Map(
    (await sql`SELECT version, checksum FROM schema_migrations`).map((r) => [
      String(r['version']),
      String(r['checksum']),
    ]),
  );
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const statements = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(statements).digest('hex');
    const seen = applied.get(version);
    if (seen !== undefined) {
      if (seen !== checksum) {
        throw new Error(
          `migration ${version} changed after it was applied (checksum mismatch) — revert the edit or add a new migration file`,
        );
      }
      continue; // applied unchanged: re-run is a no-op
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(statements);
      await tx`INSERT INTO schema_migrations (version, checksum) VALUES (${version}, ${checksum}) ON CONFLICT DO NOTHING`;
    });
  }
}
