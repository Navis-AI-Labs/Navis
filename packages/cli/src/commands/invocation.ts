import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  bridgeRequestSchema,
  declaredProjectId,
  newRequestId,
  type BridgeRequest,
} from '@navis/bridge-daemon';

export interface CliDeps {
  readonly cwd: () => string;
  readonly send: (request: BridgeRequest) => Promise<unknown>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Parse only CLI syntax; the shared request schema owns operation validation. */
export function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      remote: { type: 'string' },
      'credential-file': { type: 'string' },
      project: { type: 'string' },
      id: { type: 'string' },
      'request-id': { type: 'string' },
      file: { type: 'string' },
      participant: { type: 'string' },
      action: { type: 'string' },
      session: { type: 'string' },
      job: { type: 'string' },
      query: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'string' },
      types: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'local-only': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
}

async function inputFile(file: string | undefined, cwd: string): Promise<unknown> {
  if (file === undefined) throw new Error('--file is required');
  const target = path.resolve(cwd, file);
  if ((await stat(target)).size > 262_144) throw new Error('input file exceeds 256 KiB');
  // Windows PowerShell's UTF-8 writer includes a BOM; it is encoding metadata, not JSON content.
  return JSON.parse((await readFile(target, 'utf8')).replace(/^\uFEFF/u, '')) as unknown;
}

/** Executes one invocation through the Bridge; neither credentials nor remote transport live in CLI. */
export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  try {
    const { positionals, values } = parse(argv);
    if (values.help || positionals.length === 0) {
      deps.stdout(
        'navis configure | init | projects | state | history | command | member | capture | sync | status | hook | assist | assist-status | stop\nUse --file for command/capture JSON; --project overrides navis.toml.',
      );
      return 0;
    }
    if (positionals.length !== 1) throw new Error('expected one command');
    const cwd = deps.cwd();
    const key = values['request-id'] ?? newRequestId();
    const project = (): string => values.project ?? declaredProjectId(cwd);
    let request: unknown;
    const verb = positionals[0] ?? '';
    switch (verb) {
      case 'configure':
        request = {
          op: 'configure',
          remote: values.remote,
          credential_file:
            values['credential-file'] === undefined
              ? undefined
              : path.resolve(cwd, values['credential-file']),
        };
        break;
      case 'init':
        request = {
          op: 'project.create',
          request: { project_id: values.id ?? newRequestId(), title: values.name },
          key,
          cwd,
        };
        break;
      case 'state':
        request = { op: 'project.state', project_id: project() };
        break;
      case 'command':
        request = {
          op: 'project.command',
          project_id: project(),
          command: await inputFile(values.file, cwd),
          key,
        };
        break;
      case 'member':
        request = {
          op: 'project.member',
          project_id: project(),
          request: { participant_id: values.participant, action: values.action ?? 'grant' },
          key,
        };
        break;
      case 'capture':
        request = {
          op: 'capture',
          event_id: key,
          cwd,
          step: await inputFile(values.file, cwd),
          session_id: values.session ?? 'manual',
          privacy: values['local-only'] ? 'local-only' : 'metadata',
        };
        break;
      case 'history':
        request = {
          op: 'project.context',
          request: {
            project_id: project(),
            filter: {
              types: (values.types ?? 'session').split(','),
              ...(values.from === undefined ? {} : { from: values.from }),
              ...(values.to === undefined ? {} : { to: values.to }),
            },
            limit: Number(values.limit ?? 20),
            ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
          },
        };
        break;
      case 'projects':
        request = {
          op: 'project.search',
          request: {
            query: values.query ?? '',
            limit: Number(values.limit ?? 20),
            ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
          },
        };
        break;
      case 'assist':
        request = {
          op: 'assistance.request',
          project_id: project(),
          request: await inputFile(values.file, cwd),
          key,
        };
        break;
      case 'assist-status':
        request = { op: 'assistance.status', project_id: project(), job_id: values.job };
        break;
      case 'hook':
        request = { op: 'hook.session.start', cwd, request_id: key };
        break;
      case 'sync':
      case 'status':
      case 'stop':
        request = { op: positionals[0] };
        break;
      default:
        throw new Error('unknown command; use --help');
    }
    const result = await deps.send(bridgeRequestSchema.parse(request));
    deps.stdout(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : 'CLI operation failed');
    return 1;
  }
}
