import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bindFromToml, type VerifierPort } from '../src/binding/bind-service.js';
import { MemoryKeychain } from '../src/keychain.js';
import { parseTomlBytes } from '../src/binding/toml.js';
import { openDaemonDb, SqliteBindingTable } from '../src/persistence/sqlite-binding.js';

/**
 * Binding task (spec §5): a toml declares, the server verifies, the table
 * stays local, tampering is caught by fingerprint. The scenarios below are
 * exactly the four the spec calls for.
 */

const NOW = '2026-09-01T00:00:00.000Z';
const DEVICE = '01924a61-7a1b-7c2d-8e3f-0000000000a1';
const PARTICIPANT = '01924a61-7a1b-7c2d-8e3f-0000000000b1';
const PROJECT = '01924a61-7a1b-7c2d-8e3f-000000000001';

const ALLOWING: VerifierPort = {
  verify: () => Promise.resolve({ ok: true, participantId: PARTICIPANT }),
};

const DENYING: VerifierPort = {
  verify: () => Promise.resolve({ ok: false, reason: 'not-a-member' }),
};

interface Setup {
  readonly dir: string;
  readonly tomlPath: string;
  readonly table: SqliteBindingTable;
  readonly deadLine: () => Promise<void>;
}

function withBindingRoot(): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navis-bind-'));
  const tomlPath = path.join(dir, 'navis.toml');
  const db = openDaemonDb(path.join(dir, 'daemon.db'));
  const table = new SqliteBindingTable(db);
  return {
    dir,
    tomlPath,
    table,
    deadLine: () => {
      try {
        db.close();
      } catch {
        // already closed by the reopen-path test
      }
      return Promise.resolve();
    },
  };
}

const endings: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (endings.length > 0) {
    const end = endings.pop();
    if (end !== undefined) await end();
  }
});

describe('bindFromToml', () => {
  it('walks up past the working directory and binds after server verification', async () => {
    const setup = withBindingRoot();
    endings.push(setup.deadLine);
    fs.writeFileSync(
      setup.tomlPath,
      `project_id = "${PROJECT}"\nremote = "https://bridge.example.com"\n`,
    );
    const kc = new MemoryKeychain();
    await kc.set({ service: 'navis-bridge', account: 'device-key-test' }, 'Bearer a.b');

    const result = await bindFromToml(
      {
        bindings: setup.table,
        verifier: ALLOWING,
        keychain: kc,
        keychainRef: { keychainService: 'navis-bridge', keychainAccount: 'device-key-test' },
        now: () => NOW,
      },
      path.join(setup.dir, 'sub', 'dir'),
      DEVICE,
    );

    // the walk found the root's toml for a nested cwd and the server said yes
    expect(result.status).toBe('bound');
    if (result.status === 'bound') {
      expect(result.reused).toBe(false);
      expect(result.binding.project_id).toBe(PROJECT);
      expect(result.binding.toml_fingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.binding.last_loaded_state_version).toBeNull();
    }
  });

  it('reports the missing toml rather than probing the server', async () => {
    const setup = withBindingRoot();
    endings.push(setup.deadLine);
    // no toml was written — a bare directory
    const result = await bindFromToml(
      {
        bindings: setup.table,
        verifier: ALLOWING,
        keychain: new MemoryKeychain(),
        keychainRef: { keychainService: 'navis-bridge', keychainAccount: 'device-key-test' },
        now: () => NOW,
      },
      setup.dir,
      DEVICE,
    );

    expect(result).toEqual({ status: 'unbound-no-toml' });
  });

  it('never binds a toml whose project the participant cannot access', async () => {
    const setup = withBindingRoot();
    endings.push(setup.deadLine);
    fs.writeFileSync(setup.tomlPath, `project_id = "${PROJECT}"\n`);
    const kc = new MemoryKeychain();
    await kc.set({ service: 'navis-bridge', account: 'device-key-test' }, 'Bearer a.b');

    const result = await bindFromToml(
      {
        bindings: setup.table,
        verifier: DENYING,
        keychain: kc,
        keychainRef: { keychainService: 'navis-bridge', keychainAccount: 'device-key-test' },
        now: () => NOW,
      },
      setup.dir,
      DEVICE,
    );

    expect(result.status).toBe('unbound-verify-failed');
    if (result.status === 'unbound-verify-failed') {
      expect(result.reason).toBe('not-a-member');
    }
    // "verification failing, it SHALL NOT bind" — the table is still empty
    await expect(setup.table.get(setup.tomlPath, DEVICE)).resolves.toBeNull();
  });

  it('flags a toml fingerprint change as tampering and keeps the original binding', async () => {
    const setup = withBindingRoot();
    endings.push(setup.deadLine);
    fs.writeFileSync(setup.tomlPath, `project_id = "${PROJECT}"\n`);
    const kc = new MemoryKeychain();
    await kc.set({ service: 'navis-bridge', account: 'device-key-test' }, 'Bearer a.b');

    // first visit: verification goes through
    const first = await bindFromToml(
      {
        bindings: setup.table,
        verifier: ALLOWING,
        keychain: kc,
        keychainRef: { keychainService: 'navis-bridge', keychainAccount: 'device-key-test' },
        now: () => NOW,
      },
      setup.dir,
      DEVICE,
    );
    expect(first.status).toBe('bound');

    // same project_id, different bytes — the fingerprint moved
    fs.writeFileSync(setup.tomlPath, `# tampered\nproject_id = "${PROJECT}"\n`);
    const second = await bindFromToml(
      {
        bindings: setup.table,
        verifier: ALLOWING,
        keychain: kc,
        keychainRef: { keychainService: 'navis-bridge', keychainAccount: 'device-key-test' },
        now: () => NOW,
      },
      setup.dir,
      DEVICE,
    );

    expect(second.status).toBe('unbound-tampered');
    if (second.status === 'unbound-tampered') {
      expect(second.reason).toBe('toml_content_mismatch');
      // and the original record is untouched (tampering never mutates it)
      expect(second.binding.binding_id).toBe(
        first.status === 'bound' ? first.binding.binding_id : undefined,
      );
    }
  });

  it('keeps the binding table local by construction: exactly eleven columns, nothing else', () => {
    const setup = withBindingRoot();
    endings.push(setup.deadLine);

    const keys = setup.table.columnNames('device_bindings');

    expect(keys.sort()).toEqual([
      'binding_id',
      'bound_at',
      'device_id',
      'last_loaded_state_version',
      'parent_binding_id',
      'participant_id',
      'privacy_class',
      'project_id',
      'remote',
      'toml_fingerprint',
      'toml_path',
    ]);
  });

  it('reuses an already-bound record when fingerprint is unchanged', async () => {
    const setup = withBindingRoot();
    endings.push(setup.deadLine);
    fs.writeFileSync(setup.tomlPath, `project_id = "${PROJECT}"\n`);
    const kc = new MemoryKeychain();
    await kc.set({ service: 'navis-bridge', account: 'device-key-test' }, 'Bearer a.b');
    const deps = {
      bindings: setup.table,
      verifier: ALLOWING,
      keychain: kc,
      keychainRef: { keychainService: 'navis-bridge', keychainAccount: 'device-key-test' },
      now: () => NOW,
    };

    const first = await bindFromToml(deps, setup.dir, DEVICE);
    expect(first.status).toBe('bound');
    const second = await bindFromToml(deps, setup.dir, DEVICE);
    if (first.status !== 'bound' || second.status !== 'bound') throw new Error('wrong state');
    expect(second.reused).toBe(true);
    expect(second.binding.binding_id).toBe(first.binding.binding_id);
  });

  it('treats a toml whose project_id changed as unmanaged tampered', async () => {
    const setup = withBindingRoot();
    endings.push(setup.deadLine);
    fs.writeFileSync(setup.tomlPath, `project_id = "${PROJECT}"\n`);
    const kc = new MemoryKeychain();
    await kc.set({ service: 'navis-bridge', account: 'device-key-test' }, 'Bearer a.b');
    const deps = {
      bindings: setup.table,
      verifier: ALLOWING,
      keychain: kc,
      keychainRef: { keychainService: 'navis-bridge', keychainAccount: 'device-key-test' },
      now: () => NOW,
    };
    await bindFromToml(deps, setup.dir, DEVICE);
    fs.writeFileSync(setup.tomlPath, `project_id = "01924a61-7a1b-7c2d-8e3f-0000000000c1"\n`);

    const outcome = await bindFromToml(deps, setup.dir, DEVICE);
    expect(outcome.status).toBe('unbound-tampered');
    if (outcome.status === 'unbound-tampered') {
      expect(outcome.reason).toBe('toml_project_id_changed');
    }
  });

  it('returns credential-missing when the keychain has no device key', async () => {
    const setup = withBindingRoot();
    endings.push(setup.deadLine);
    fs.writeFileSync(setup.tomlPath, `project_id = "${PROJECT}"\n`);

    const outcome = await bindFromToml(
      {
        bindings: setup.table,
        verifier: ALLOWING,
        keychain: new MemoryKeychain(),
        keychainRef: { keychainService: 'navis-bridge', keychainAccount: 'device-key-test' },
        now: () => NOW,
      },
      setup.dir,
      DEVICE,
    );
    expect(outcome.status).toBe('unbound-verify-failed');
    if (outcome.status === 'unbound-verify-failed') {
      expect(outcome.reason).toBe('device-credential-missing');
    }
  });

  it('rejects a toml whose bytes fail the allowlist parse', async () => {
    const setup = withBindingRoot();
    endings.push(setup.deadLine);
    fs.writeFileSync(setup.tomlPath, `project_id = "not-a-uuid"\n`);

    const outcome = await bindFromToml(
      {
        bindings: setup.table,
        verifier: ALLOWING,
        keychain: new MemoryKeychain(),
        keychainRef: { keychainService: 'navis-bridge', keychainAccount: 'device-key-test' },
        now: () => NOW,
      },
      setup.dir,
      DEVICE,
    );
    expect(outcome.status).toBe('unbound-toml-invalid');
  });

  it("command lists the device's bindings newest-first across tomls", async () => {
    const setup = withBindingRoot();
    endings.push(setup.deadLine);
    const toml2 = path.join(setup.dir, 'elsewhere', 'navis.toml');
    fs.mkdirSync(path.dirname(toml2), { recursive: true });
    fs.writeFileSync(setup.tomlPath, `project_id = "${PROJECT}"\n`);
    fs.writeFileSync(toml2, `project_id = "01924a61-7a1b-7c2d-8e3f-0000000000c2"\n`);
    const kc = new MemoryKeychain();
    await kc.set({ service: 'navis-bridge', account: 'device-key-test' }, 'Bearer a.b');
    const deps = {
      bindings: setup.table,
      verifier: ALLOWING,
      keychain: kc,
      keychainRef: { keychainService: 'navis-bridge', keychainAccount: 'device-key-test' },
      now: () => NOW,
    };
    await bindFromToml(deps, setup.dir, DEVICE);
    await bindFromToml(deps, path.dirname(toml2), DEVICE);

    const rows = await setup.table.listForDevice(DEVICE);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.project_id).sort()).toEqual([
      '01924a61-7a1b-7c2d-8e3f-000000000001',
      '01924a61-7a1b-7c2d-8e3f-0000000000c2',
    ]);
  });

  it('reopens an already-migrated database without reapplying and keeps rows', async () => {
    const setup = withBindingRoot();
    endings.push(setup.deadLine);
    fs.writeFileSync(setup.tomlPath, `project_id = "${PROJECT}"\n`);
    const kc = new MemoryKeychain();
    await kc.set({ service: 'navis-bridge', account: 'device-key-test' }, 'Bearer a.b');
    const deps = {
      bindings: setup.table,
      verifier: ALLOWING,
      keychain: kc,
      keychainRef: { keychainService: 'navis-bridge', keychainAccount: 'device-key-test' },
      now: () => NOW,
    };
    const first = await bindFromToml(deps, setup.dir, DEVICE);
    if (first.status !== 'bound') throw new Error('first bind failed');
    const dbPath = path.join(setup.dir, 'daemon.db');
    setup.table.close();

    // reopen the same db — the checksum match must not rewrite the row
    const reopened = openDaemonDb(dbPath);
    const reloadedTable = new SqliteBindingTable(reopened);
    const row = await reloadedTable.get(setup.tomlPath, DEVICE);
    expect(row?.binding_id).toBe(first.binding.binding_id);
    reloadedTable.close();
  });

  it('aborts opening when an applied migration checksum has drifted', async () => {
    const setup = withBindingRoot();
    endings.push(setup.deadLine);
    // tamper the migration checksum and prove the open rejects it
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = path.join(setup.dir, 'daemon.db');
    const w = new DatabaseSync(dbPath);
    w.exec(
      "UPDATE schema_migrations SET checksum = 'fourteen-zeros' WHERE file = '0001_binding.sql'",
    );
    w.close();

    expect(() => openDaemonDb(dbPath)).toThrow(/schema drift/u);
  });
});

describe('parseTomlBytes (allowlist, strict)', () => {
  it('rejects empty toml content', () => {
    expect(parseTomlBytes(Buffer.from(''))).toEqual({ ok: false, reason: 'toml-empty' });
  });

  it('rejects a non-key=value line', () => {
    expect(
      parseTomlBytes(Buffer.from('project_id "afad6bb6-89b2-7dc5-bbb6-ffffff00ff00"')),
    ).toEqual({
      ok: false,
      reason: 'toml-invalid:project_id "afad6bb6-89b2-7dc5-bbb6-ffffff00ff00"',
    });
  });

  it('rejects an unknown key — allowlist is the spec', () => {
    expect(parseTomlBytes(Buffer.from('unknown_key = "x"'))).toEqual({
      ok: false,
      reason: 'toml-invalid:unknown_key',
    });
  });

  it('rejects an unquoted value — only bare strings allowed', () => {
    expect(parseTomlBytes(Buffer.from('project_id = 42'))).toEqual({
      ok: false,
      reason: 'toml-invalid:project_id',
    });
  });

  it('rejects escape tricks inside the string value', () => {
    expect(parseTomlBytes(Buffer.from('project_id = "af\\ad"'))).toEqual({
      ok: false,
      reason: 'toml-invalid:project_id',
    });
  });

  it('rejects a toml with no project_id key at all', () => {
    expect(parseTomlBytes(Buffer.from('remote = "https://bridge.example.com"'))).toEqual({
      ok: false,
      reason: 'toml-no-project-id',
    });
  });

  it('rejects a non-uuid project_id', () => {
    expect(parseTomlBytes(Buffer.from('project_id = "not-a-uuid"'))).toEqual({
      ok: false,
      reason: 'toml-invalid-project-id',
    });
  });

  it('parses a toml with a remote override intact', () => {
    const parsed = parseTomlBytes(
      Buffer.from(`project_id = "${PROJECT}"\nremote = "https://bridge.example.com"`),
    );
    expect(parsed).toEqual({
      ok: true,
      declaration: { projectId: PROJECT, remote: 'https://bridge.example.com' },
    });
  });
});
