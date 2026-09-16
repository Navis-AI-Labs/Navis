import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@navis/domain';

import { InMemoryCommandInbox } from '../src/persistence/in-memory/in-memory-command-inbox.js';
import { createConnection, runMigrations } from '../src/persistence/postgres/connection.js';
import { PostgresCommandInbox } from '../src/persistence/postgres/postgres-command-inbox.js';

import { commandInboxContractSuite } from './command-inbox.contract.js';

commandInboxContractSuite('InMemoryCommandInbox contract', () => new InMemoryCommandInbox());

const databaseUrl = process.env['DATABASE_URL'];
describe.runIf(databaseUrl !== undefined)('PostgresCommandInbox contract', () => {
  const sql = databaseUrl === undefined ? undefined : createConnection(databaseUrl);
  beforeAll(async () => {
    if (sql) await runMigrations(sql);
  });
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 0 });
  });

  commandInboxContractSuite('shared cases', () => {
    if (!sql) throw new Error('DATABASE_URL is required for this suite');
    return new PostgresCommandInbox(sql);
  });

  it('racing begins for the same key have exactly one fresh winner', async () => {
    if (!sql) throw new Error('DATABASE_URL is required for this suite');
    const inbox = new PostgresCommandInbox(sql);
    const project = uuidv7();
    const hash = 'sha256:' + 'ab'.repeat(32);
    const verdicts = await Promise.all(
      Array.from({ length: 8 }, () => inbox.begin(project, 'race-1', 'create_project', hash)),
    );
    expect(verdicts.filter((v) => v.status === 'fresh')).toHaveLength(1);
    expect(verdicts.filter((v) => v.status === 'processing')).toHaveLength(7);
  });
});
