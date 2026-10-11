import net from 'node:net';
import { request, Server } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createApiServer } from '../src/platform/server.js';
import { loadApiConfig } from '../src/platform/config.js';
it('forces idle pre-request connections closed at the shutdown deadline', async () => {
  const emitted = vi.spyOn(Server.prototype, 'emit');
  const forced = vi.spyOn(Server.prototype, 'closeAllConnections');
  const server = createApiServer(
    { ...loadApiConfig({}), shutdown_timeout_ms: 10 },
    { write: () => undefined },
  );
  const port = await server.listen(0, '127.0.0.1');
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      resolve();
    });
    socket.once('error', reject);
  });
  const closed = new Promise<void>((resolve) =>
    socket.once('close', () => {
      resolve();
    }),
  );
  let peer: net.Socket | undefined;
  await vi.waitFor(() => {
    const calls: readonly (readonly unknown[])[] = emitted.mock.calls;
    const candidate = calls.find((args) => args[0] === 'connection')?.[1];
    expect(candidate).toBeInstanceOf(net.Socket);
    if (candidate instanceof net.Socket) peer = candidate;
  });
  if (peer === undefined) throw new Error('accepted connection missing');
  const received = once(peer, 'data');
  // Keep parsing in progress so close cannot discard this as an unused idle socket.
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
  await received;
  await server.close();
  await closed;
  expect(socket.destroyed).toBe(true);
  expect(forced).toHaveBeenCalledOnce();
});
it('forces a non-completing operation closed without waiting for its promise', async () => {
  let arrived: () => void = () => undefined;
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const server = createApiServer(
    { ...loadApiConfig({}), shutdown_timeout_ms: 10 },
    { write: () => undefined },
    [
      {
        method: 'GET',
        path: '/hang',
        requiresBody: false,
        handle: () => {
          arrived();
          return new Promise(() => undefined);
        },
      },
    ],
  );
  const port = await server.listen(0, '127.0.0.1');
  const disconnected = new Promise<void>((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/hang' });
    req.once('error', () => {
      resolve();
    });
    req.end();
  });
  await arrival;
  await server.close();
  await disconnected;
});
