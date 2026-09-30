import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Platform-specific filesystem surfaces for the per-user daemon (spec: IPC
 * is a Unix domain socket on macOS/Linux and a named pipe on Windows).
 *
 * - `dataDir`  — durable state (the SQLite Outbox database lives here).
 * - `runtimeDir` — transient state (socket / lock), gone with a reboot; falls
 *   back to a per-user tmp directory when nothing honours XDG_RUNTIME_DIR.
 * - `socketPath` — on Unix the path the IPC listener binds; on Windows the
 *   named-pipe UNC path. The transport differs; everything past this string
 *   is identical.
 *
 * The resolver is pure: `platform` and `env` come in as arguments so the
 * tri-platform matrix runs on any CI host without mocking the process.
 */

export type PlatformCode = Extract<NodeJS.Platform, 'darwin' | 'linux' | 'win32'>;

export interface DaemonPaths {
  /** Durable, user-owned data directory (Outbox database, binding table). */
  readonly dataDir: string;
  /** Transient per-boot directory that holds the socket and the lock file. */
  readonly runtimeDir: string;
  /** Adventurous-`wx` lock file used by the single-instance gate. */
  readonly lockPath: string;
  /** Unix socket path on darwin/linux; named-pipe UNC path on win32. */
  readonly socketPath: string;
  /** Keychain service label; the device key is stored under this entry. */
  readonly keychainService: string;
  /** Keychain account label inside the service entry. */
  readonly keychainAccount: string;
}

/** XDG-style per-user data home on Unix; platform-native on Windows/macOS. */
function dataHome(platform: PlatformCode, env: NodeJS.ProcessEnv, home: string): string {
  switch (platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'navis-bridge');
    case 'win32':
      // win32 separators: the resolved shape is the UNC form on Windows, and
      // the test matrix asserts the same shape from any CI host
      return path.win32.join(
        env['LOCALAPPDATA'] ?? path.win32.join(home, 'AppData', 'Local'),
        'navis-bridge',
      );
    case 'linux':
      return path.join(env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share'), 'navis-bridge');
    /* v8 ignore next 1 -- the union is exhausted at compile time */
    default:
      return path.join(env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share'), 'navis-bridge');
  }
}

/** Per-boot runtime directory: socket + lock live here. */
function runtimeHome(
  platform: PlatformCode,
  env: NodeJS.ProcessEnv,
  home: string,
  uid: number,
): string {
  void platform;
  if (env['XDG_RUNTIME_DIR'] !== undefined && env['XDG_RUNTIME_DIR'] !== '') {
    return path.join(env['XDG_RUNTIME_DIR'], 'navis-bridge');
  }
  // per-user tmp fallback: no owner-only guarantee the port advertises,
  // so callers monkey with the lock file at their own risk on multi-user hosts
  return path.join(env['TMPDIR'] ?? os.tmpdir(), `navis-bridge-run-${String(uid)}`);
}

export interface ResolvePathsOptions {
  readonly platform?: PlatformCode;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly uid?: number;
}

/**
 * Resolves every filesystem surface for this user's daemon. Defaults read
 * the live process; tests pass explicit platforms + env to pin a matrix on
 * a single host.
 */
export function resolveDaemonPaths(options: ResolvePathsOptions = {}): DaemonPaths {
  const platform: PlatformCode = (options.platform ?? process.platform) as PlatformCode;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);

  const dataDir = dataHome(platform, env, home);
  const runtimeDir = runtimeHome(platform, env, home, uid);
  return {
    dataDir,
    runtimeDir,
    lockPath:
      platform === 'win32'
        ? path.join(dataDir, 'daemon.lock')
        : path.join(runtimeDir, 'daemon.lock'),
    socketPath:
      platform === 'win32'
        ? `\\\\.\\pipe\\navis-bridge-${env['USERNAME'] ?? `uid-${String(uid)}`}`
        : path.join(runtimeDir, 'bridge.sock'),
    keychainService: 'navis-bridge',
    keychainAccount: `device-key-${env['USER'] ?? env['USERNAME'] ?? 'default'}`,
  };
}
