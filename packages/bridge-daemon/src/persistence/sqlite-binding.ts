import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BindingRecord, BindingTablePort } from '../binding/ports.js';

/**
 * The daemon's only database: node:sqlite in WAL mode (ADR-0012).
 *
 * One file, one writer, zero runtime dependency. The migration runner
 * mirrors the server's convention: versioned `.sql` files tracked in a
 * `schema_migrations` table with a sha256 checksum each. Tampering with an
 * already-applied migration is itself an integrity violation and refuses the
 * database until the operator resets state (the binding table's tamper story
 * lives at the toml layer, not the schema layer).
 */

interface Migration {
  readonly version: number;
  readonly file: string;
  readonly sqlite: string;
  readonly checksum: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, 'migrations');

function loadMigrations(): Migration[] {
  /* v8 ignore next -- sort comparison only fires with 2+ migrations; today there is one */
  const cmp = (a: Migration, b: Migration): number => a.version - b.version;
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const sqlite = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      return {
        version: Number.parseInt(name.slice(0, 4), 10),
        file: name,
        sqlite,
        checksum: createHash('sha256').update(sqlite).digest('hex'),
      };
    })
    .sort(cmp);
}

/** Opens a daemon database in WAL mode and applies pending migrations. */
export function openDaemonDb(filePath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  // WAL >= readers-cohere while writer appends; NORMAL durability suits a
  // machine-local buffer whose authoritative copy is the server (ADR-0012).
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // bookkeeping before migration: the checksum row can only land after the table exists
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (file TEXT PRIMARY KEY, checksum TEXT NOT NULL)',
  );
  const migrations = loadMigrations();
  const stmt = db.prepare('SELECT file, checksum FROM schema_migrations');
  const applied = new Map(
    (stmt.all() as { file: string; checksum: string }[]).map((row) => [row.file, row.checksum]),
  );
  for (const migration of migrations) {
    const existing = applied.get(migration.file);
    if (existing !== undefined) {
      if (existing !== migration.checksum) {
        throw new Error(`schema drift: ${migration.file} checksum mismatch`);
      }
      continue;
    }
    db.exec(migration.sqlite);
    db.prepare('INSERT INTO schema_migrations (file, checksum) VALUES (?, ?)').run(
      migration.file,
      migration.checksum,
    );
  }
  return db;
}

interface Row {
  readonly binding_id: unknown;
  readonly project_id: unknown;
  readonly toml_path: unknown;
  readonly toml_fingerprint: unknown;
  readonly device_id: unknown;
  readonly participant_id: unknown;
  readonly remote: unknown;
  readonly privacy_class: unknown;
  readonly bound_at: unknown;
  readonly last_loaded_state_version: unknown;
  readonly parent_binding_id: unknown;
}

function readRow(row: Row): BindingRecord {
  const asText = (v: unknown): string => {
    /* v8 ignore next 1 -- pragma/DDL output is always text; belt-and-braces guard */
    if (typeof v !== 'string') throw new Error('expected a text column');
    return v;
  };
  const asTextOrNull = (v: unknown): string | null => (v === null ? null : asText(v));
  return {
    binding_id: asText(row.binding_id),
    project_id: asText(row.project_id),
    toml_path: asText(row.toml_path),
    toml_fingerprint: asText(row.toml_fingerprint),
    device_id: asText(row.device_id),
    participant_id: asText(row.participant_id),
    remote: asTextOrNull(row.remote),
    /* v8 ignore next 1 -- the CHECK constraint pins the union; adapters only see it */
    privacy_class: asText(row.privacy_class) as BindingRecord['privacy_class'],
    bound_at: asText(row.bound_at),
    last_loaded_state_version:
      row.last_loaded_state_version === null ? null : Number(row.last_loaded_state_version),
    parent_binding_id: null,
  };
}

/** SQLite adapter over the binding table. Local-only by construction. */
export class SqliteBindingTable implements BindingTablePort {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  close(): void {
    this.#db.close();
  }

  columnNames(table: string): string[] {
    return this.#db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => (row as { name: string }).name);
  }

  async put(record: BindingRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO device_bindings (
          binding_id, project_id, toml_path, toml_fingerprint, device_id,
          participant_id, remote, privacy_class, bound_at,
          last_loaded_state_version, parent_binding_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        record.binding_id,
        record.project_id,
        record.toml_path,
        record.toml_fingerprint,
        record.device_id,
        record.participant_id,
        record.remote,
        record.privacy_class,
        record.bound_at,
        record.last_loaded_state_version,
      );
    return Promise.resolve();
  }

  async get(tomlPath: string, deviceId: string): Promise<BindingRecord | null> {
    const row = this.#db
      .prepare('SELECT * FROM device_bindings WHERE toml_path = ? AND device_id = ?')
      .get(tomlPath, deviceId) as unknown as Row | undefined;
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve(readRow(row));
  }

  async listForDevice(deviceId: string): Promise<readonly BindingRecord[]> {
    const rows = this.#db
      .prepare('SELECT * FROM device_bindings WHERE device_id = ? ORDER BY bound_at DESC')
      .all(deviceId) as unknown as Row[];
    return Promise.resolve(rows.map(readRow));
  }
}
