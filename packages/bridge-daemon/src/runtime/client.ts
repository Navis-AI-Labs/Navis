import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { bridgeRequestSchema, type BridgeRequest } from './request.js';
import { ipcPing } from '../ipc.js';
import { resolveDaemonPaths, type DaemonPaths } from '../paths.js';

/** One request per socket, with bounded framing and a deadline. */
export function sendBridge(
  request: BridgeRequest,
  socketPath: string,
  timeoutMs = 35_000,
): Promise<unknown> {
  const frame = JSON.stringify(bridgeRequestSchema.parse(request));
  if (Buffer.byteLength(frame) > 524_288)
    return Promise.reject(new Error('Bridge request too large'));
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => {
      finish(new Error('Bridge response timed out'));
    });
    socket.once('error', (error) => {
      finish(error);
    });
    socket.once('close', () => {
      finish(new Error('Bridge connection closed before a reply'));
    });
    socket.once('connect', () => socket.write(`${frame}\n`));
    socket.on('data', (chunk: Buffer) => {
      if (buffer.length + chunk.length > 16_777_216) {
        finish(new Error('Bridge response too large'));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const reply: unknown = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        if (typeof reply !== 'object' || reply === null || !('ok' in reply))
          throw new Error('invalid Bridge reply');
        if (reply.ok !== true)
          throw new Error(
            'detail' in reply && typeof reply.detail === 'string'
              ? reply.detail
              : 'Bridge operation refused',
          );
        finish(undefined, 'data' in reply ? reply.data : undefined);
      } catch (error) {
        finish(error instanceof Error ? error : new Error('invalid Bridge reply'));
      }
    });
  });
}

/** Spawns the packaged daemon process only when no live IPC listener responds. */
export async function invokeBridge(
  request: BridgeRequest,
  paths: DaemonPaths = resolveDaemonPaths(),
  entry = fileURLToPath(new URL('../process/index.js', import.meta.url)),
): Promise<unknown> {
  if ((await ipcPing(paths.socketPath)) === null) {
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    });
    const status = { failed: false };
    child.once('error', () => {
      status.failed = true;
    });
    child.unref();
    let running = false;
    // Native access-control initialization can be slower on a cold Windows host.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !status.failed) {
      await delay(100);
      if ((await ipcPing(paths.socketPath, 250)) !== null) {
        running = true;
        break;
      }
    }
    if (!running)
      throw new Error('Bridge startup failed; run the packaged daemon directly for diagnostics');
  }
  return sendBridge(request, paths.socketPath);
}
