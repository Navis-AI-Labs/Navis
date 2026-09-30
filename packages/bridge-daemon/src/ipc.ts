import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * IPC transport for the daemon: newline-delimited JSON frames over a
 * platform transport (Unix domain socket on darwin/linux, named pipe on
 * win32 — Node's `net` module hosts both shapes with identical semantics).
 *
 * The frame format is one JSON value per line, small and strict (spec: the
 * protocol is owned by this package; the wire contract between CLI and
 * daemon is internal). The shape:
 *
 * - Request: `{op: string; payload?: unknown}`
 * - Reply:   `{ok: true; data: unknown}` or `{ok: false; detail: string}`
 *
 * The daemon routes by `op`; handlers are registered at construction so the
 * transport carries no daemon-domain assumptions.
 */

/** Decoded request frame carried by the IPC transport. */
export interface IpcRequest {
  readonly op: string;
  readonly payload?: unknown;
}

export interface IpcReply {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly detail?: string;
}

export type IpcHandler = (request: IpcRequest) => Promise<IpcReply>;

export interface IpcServer {
  listen(socketPath: string): Promise<void>;
  close(): Promise<void>;
}

/** A single connection's message framing: newline-delimited JSON. */
function bindConnection(socket: net.Socket, handler: IpcHandler): void {
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    let newline = buffer.indexOf(0x0a);
    while (newline >= 0) {
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (frame.length > 0) void handleFrame(socket, frame, handler);
      newline = buffer.indexOf(0x0a);
    }
  });

  socket.on(
    'error',
    /* v8 ignore next 3 -- the peer disappearing mid-read is a client matter */ () => {
      socket.destroy();
    },
  );
}

async function handleFrame(socket: net.Socket, frame: Buffer, handler: IpcHandler): Promise<void> {
  let reply: IpcReply;
  try {
    const raw: unknown = JSON.parse(frame.toString('utf8'));
    if (typeof raw !== 'object' || raw === null || !('op' in raw) || typeof raw.op !== 'string') {
      reply = { ok: false, detail: 'malformed-frame' };
    } else {
      reply = await handler(raw as IpcRequest);
    }
  } catch (error) {
    reply =
      /* v8 ignore next 1 -- JSON.parse and the handler are the only throwers */
      { ok: false, detail: error instanceof Error ? error.message : 'internal' };
  }
  socket.write(`${JSON.stringify(reply)}\n`);
}

export class NodeIpcServer implements IpcServer {
  readonly #handler: IpcHandler;
  #server: net.Server | undefined;

  constructor(handler: IpcHandler) {
    this.#handler = handler;
  }

  /**
   * Binds the socket. `EADDRINUSE` maps to "a live daemon owns this slot":
   * callers that see it should probe the existing instance instead of
   * retrying (single-instance semantics come from the lock, IPC coherence
   * comes from this binding).
   */
  async listen(socketPath: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(socketPath), { recursive: true });
    const server = net.createServer((socket) => {
      bindConnection(socket, this.#handler);
    });
    await new Promise<void>((resolve, reject) => {
      server.on('error', (error: NodeJS.ErrnoException) => {
        reject(error);
      });
      server.listen(socketPath, () => {
        resolve();
      });
    });
    this.#server = server;
  }

  close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

/**
 * One-shot IPC call: `ping` is the liveness probe — a handshake that returns
 * the holding process's pid so the single-instance gate can decide reuse
 * instead of trusting the lock file's pid alone.
 */
export async function ipcPing(socketPath: string): Promise<{ pid: number } | null> {
  return new Promise<{ pid: number } | null>((resolve) => {
    const socket = net.connect(socketPath);
    /* v8 ignore next 4 -- a dead peer that never connects can only hang one probe round */
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, 1000);

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ op: 'ping' })}\n`);
    });

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      /* v8 ignore next 1 -- a partial first segment reaches the same handler on the next byte */
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const reply = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as {
          ok?: boolean;
          data?: { pid?: unknown };
        };
        const pid = reply.data?.pid;
        resolve(
          reply.ok === true && typeof pid === 'number' && Number.isInteger(pid) ? { pid } : null,
        );
      } catch {
        /* v8 ignore next 1 -- a reply that fails JSON.parse is a poisoned peer */
        resolve(null);
      }
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

/** Wraps the built-in ping reply so the daemon advertises its pid. */
export function pingHandler(extra?: () => Record<string, unknown>): Promise<IpcReply> {
  return Promise.resolve({
    ok: true,
    data: { pid: process.pid, nonce: randomBytes(4).toString('hex'), ...(extra?.() ?? {}) },
  });
}
