import { execFile } from 'node:child_process';

/**
 * Keychain port (spec: credentials live in the OS keychain — Keychain on
 * macOS, Credential Manager on Windows, libsecret on Linux).
 *
 * The port votes nothing about storage implementation: the shape is namespaced
 * `{service, account} → credential`, mirroring macOS `security` and libsecret
 * while keeping the Credential Manager target usable. The platform adapter
 * shells out to the host CLI so the daemon has no native build dependency;
 * the runner is injectable so behaviour tests never need a real desktop.
 */

export interface KeychainRef {
  /** OS-level service bucket (e.g. Keychain service / PasswordVault target). */
  readonly service: string;
  /** Item label inside the bucket. */
  readonly account: string;
}

export interface KeychainPort {
  /** Reads the secret; `null` when the entry does not exist. Never throws on absence. */
  get(ref: KeychainRef): Promise<string | null>;
  /** Creates or replaces the secret (upsert semantics on every platform). */
  set(ref: KeychainRef, secret: string): Promise<void>;
  /** Removes the entry; `false` when nothing was stored. */
  delete(ref: KeychainRef): Promise<boolean>;
}

/** In-memory adapter: the reference model and the test seam. */
export class MemoryKeychain implements KeychainPort {
  readonly #entries = new Map<string, string>();

  get(ref: KeychainRef): Promise<string | null> {
    return Promise.resolve(this.#entries.get(`${ref.service}/${ref.account}`) ?? null);
  }

  set(ref: KeychainRef, secret: string): Promise<void> {
    this.#entries.set(`${ref.service}/${ref.account}`, secret);
    return Promise.resolve();
  }

  delete(ref: KeychainRef): Promise<boolean> {
    return Promise.resolve(this.#entries.delete(`${ref.service}/${ref.account}`));
  }
}

/** Runner seam: (file, argv) → resolved {stdout, stderr}. */
export type ShellRunner = (
  file: string,
  argv: readonly string[],
  input?: string,
) => Promise<{ stdout: string; stderr: string }>;

/* v8 ignore next 12 -- the default runner shells out to the host CLI; tests
   inject the ShellRunner seam instead, and the platform CI re-runs the real
   binary against a matching desktop environment */
function nodeRunner(
  file: string,
  argv: readonly string[],
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...argv], (error, stdout, stderr) => {
      if (error !== null) {
        reject(
          Object.assign(new Error(`${file}: ${stderr}`.trim() || error.message), {
            code: (error as NodeJS.ErrnoException).code,
          }),
        );
        return;
      }
      resolve({ stdout, stderr });
    }).stdin?.end(input);
  });
}

/** The CLI's "not found" text varies; the pattern is what's pinned. */
function entryMissing(exitError: NodeJS.ErrnoException): boolean {
  return /could not be found|Item not found|not found/i.test(exitError.message);
}

/**
 * Shells out to the platform credential CLI so no native module is admitted
 * (standard 09). All three CLI shapes return the secret on stdout for a hit;
 * a miss is reported via a well-known stderr/id and maps to `null`.
 */
export class PlatformKeychain implements KeychainPort {
  readonly #platform: SupportedPlatform;
  readonly #runner: ShellRunner;

  constructor(platform: SupportedPlatform, runner: ShellRunner = nodeRunner) {
    this.#platform = platform;
    this.#runner = runner;
  }

  async get(ref: KeychainRef): Promise<string | null> {
    const cmd = this.#command('get', ref);
    try {
      const out = await this.#runner(cmd.file, cmd.argv);
      return out.stdout.trim();
    } catch (error) {
      /* v8 ignore next 2 -- runtimes raise ErrnoException; the runner seam injects one */
      if (error instanceof Error && entryMissing(error)) return null;
      throw error;
    }
  }

  set(ref: KeychainRef, secret: string): Promise<void> {
    const cmd = this.#command('set', ref);
    return this.#runner(cmd.file, cmd.argv, secret).then(() => undefined);
  }

  async delete(ref: KeychainRef): Promise<boolean> {
    const cmd = this.#command('delete', ref);
    try {
      await this.#runner(cmd.file, cmd.argv);
      return true;
    } catch (error) {
      if (error instanceof Error && entryMissing(error)) return false;
      throw error;
    }
  }

  #command(op: 'get' | 'set' | 'delete', ref: KeychainRef): { file: string; argv: string[] } {
    const commands = commandTable(this.#platform, ref);
    const command = commands[op];
    /* v8 ignore next 1 -- the table lists one cell per op for every supported platform */
    if (command === undefined) throw new Error(`unsupported platform: ${this.#platform}`);
    return command;
  }
}

interface KeychainCommand {
  readonly file: string;
  readonly argv: string[];
}

export type SupportedPlatform = Extract<NodeJS.Platform, 'darwin' | 'linux' | 'win32'>;

function commandTable(
  platform: SupportedPlatform,
  ref: KeychainRef,
): Partial<Record<'get' | 'set' | 'delete', KeychainCommand>> {
  switch (platform) {
    case 'darwin':
      return {
        get: {
          file: 'security',
          argv: ['find-generic-password', '-s', ref.service, '-a', ref.account, '-w'],
        },
        // -U upserts: the set path is create-or-replace by construction
        set: {
          file: 'security',
          argv: ['add-generic-password', '-U', '-s', ref.service, '-a', ref.account, '-w', '-'],
        },
        delete: {
          file: 'security',
          argv: ['delete-generic-password', '-s', ref.service, '-a', ref.account],
        },
      };
    case 'win32':
      return {
        get: {
          file: 'powershell',
          argv: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$v = New-Object Windows.Security.Credentials.PasswordVault; ` +
              `$e = $v.FindAllByResource('${ref.service}') | Where-Object { $_.Resource -eq '${ref.service}' -and $_.UserName -eq '${ref.account}' }; ` +
              `if ($e) { $e[0].RetrieveCredential(); $e[0].Password }`,
          ],
        },
        set: {
          file: 'powershell',
          argv: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$v = New-Object Windows.Security.Credentials.PasswordVault; ` +
              `$s = [Console]::In.ReadToEnd(); ` +
              `$c = New-Object Windows.Security.Credentials.PasswordCredential('${ref.service}', '${ref.account}', $s); ` +
              `$v.Add($c)`,
          ],
        },
        delete: {
          file: 'powershell',
          argv: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$v = New-Object Windows.Security.Credentials.PasswordVault; ` +
              `$e = $v.FindAllByResource('${ref.service}') | Where-Object { $_.Resource -eq '${ref.service}' -and $_.UserName -eq '${ref.account}' }; ` +
              `if ($e) { $v.Remove($e[0]); exit 0 } else { Write-Error 'not found'; exit 1 }`,
          ],
        },
      };
    case 'linux':
      return {
        get: {
          file: 'secret-tool',
          argv: ['lookup', 'service', ref.service, 'account', ref.account],
        },
        set: {
          file: 'secret-tool',
          argv: ['store', '--label=navis-bridge', 'service', ref.service, 'account', ref.account],
        },
        delete: {
          file: 'secret-tool',
          argv: ['clear', 'service', ref.service, 'account', ref.account],
        },
      };
    /* v8 ignore next -- SupportedPlatform covers the three branches above */
    default:
      return {};
  }
}
