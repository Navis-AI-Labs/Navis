import { resolveDaemonPaths, type KeychainPort, type PlatformCode } from '@navis/bridge-daemon';
import type { BridgeHookResult } from '@navis/contracts';

/**
 * Navis CLI — stateless by design. Every verb constructs its own request
 * and holds no module-level cache; re-invocation re-reads the environment.
 * Task 7.1 binds a session-start hook invocation to its contract result
 * over the daemon IPC. Everything else (init / status / session /
 * bridge link|unlink|login) is a straight IPC or keychain call.
 */

export interface IpcClient {
  send(socketPath: string, request: Record<string, unknown>): Promise<unknown>;
}

export interface CliDeps {
  readonly platform: PlatformCode;
  readonly ipc: IpcClient;
  readonly keychain: KeychainPort;
  readonly now: () => string;
  readonly cwd: () => string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** arg → parsed command: positional verb + flags map. */
export interface CliInvocation {
  readonly verb: string;
  readonly args: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

/** The verbs this slice admits. */
export const CLI_VERBS = [
  'init',
  'status',
  'session',
  'bridge link',
  'bridge unlink',
  'bridge login',
  'bridge hook',
] as const;

export type CliVerb = (typeof CLI_VERBS)[number];

export function parse(argv: readonly string[]): CliInvocation {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq >= 0) {
        flags.set(tok.slice(2, eq), tok.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags.set(tok.slice(2), next);
          i++;
        } else {
          flags.set(tok.slice(2), true);
        }
      }
    } else {
      positionals.push(tok);
    }
  }
  const verb = positionals.slice(0, 2).join(' ');
  return { verb, args: positionals.slice(2), flags };
}

interface HookDeps {
  readonly ipc: IpcClient;
  readonly cwd: () => string;
}

async function dispatchHook(
  invocation: CliInvocation,
  deps: HookDeps,
  socketPath: string,
): Promise<BridgeHookResult> {
  const tomlProjectId = invocation.flags.get('toml-project-id');
  const request: Record<string, unknown> = {
    op: 'hook.session.start',
    hook: 'session.start',
    cwd: deps.cwd(),
    toml_present: invocation.flags.get('toml-present') === true,
  };
  if (typeof tomlProjectId === 'string') request['toml_project_id'] = tomlProjectId;
  const reply = await deps.ipc.send(socketPath, request);
  return reply as BridgeHookResult;
}

/** Returns the shell exit code; stderr lines carry a named reason, never a trace. */
export async function run(invocation: CliInvocation, deps: CliDeps): Promise<number> {
  const paths = resolveDaemonPaths({ platform: deps.platform });

  switch (invocation.verb) {
    case 'init': {
      await deps.ipc.send(paths.socketPath, { op: 'init', cwd: deps.cwd() });
      deps.stdout(`initialised binding for ${deps.cwd()}`);
      return 0;
    }
    case 'status': {
      const reply = await deps.ipc.send(paths.socketPath, { op: 'status' });
      deps.stdout(JSON.stringify(reply));
      return 0;
    }
    case 'session': {
      const reply = await deps.ipc.send(paths.socketPath, { op: 'session.resume' });
      deps.stdout(JSON.stringify(reply));
      return 0;
    }
    case 'bridge link': {
      const toml = invocation.flags.get('toml');
      if (typeof toml !== 'string' || toml.length === 0) {
        deps.stderr('bridge link requires --toml <path>');
        return 2;
      }
      const reply = await deps.ipc.send(paths.socketPath, { op: 'bridge.link', toml });
      deps.stdout(JSON.stringify(reply));
      return 0;
    }
    case 'bridge unlink': {
      const reply = await deps.ipc.send(paths.socketPath, { op: 'bridge.unlink' });
      deps.stdout(JSON.stringify(reply));
      return 0;
    }
    case 'bridge login': {
      const key = invocation.flags.get('key');
      if (typeof key !== 'string' || key.length === 0) {
        deps.stderr('bridge login requires --key (format: <keyId>.<secret>)');
        return 2;
      }
      await deps.keychain.set(
        { service: paths.keychainService, account: paths.keychainAccount },
        key,
      );
      deps.stdout('device key stored in OS keychain');
      return 0;
    }
    case 'bridge hook': {
      const result = await dispatchHook(invocation, deps, paths.socketPath);
      deps.stdout(JSON.stringify(result));
      return result.status === 'unbound' ? 1 : 0;
    }
    default: {
      deps.stderr(`unknown verb: ${invocation.verb}`);
      return 2;
    }
  }
}
