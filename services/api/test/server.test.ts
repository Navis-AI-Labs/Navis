import { Agent, request } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadApiConfig, type ApiConfig } from '../src/platform/config.js';
import type { LogSink } from '../src/platform/logging.js';
import { createApiServer, type ApiServer, type ServiceRoute } from '../src/platform/server.js';

/**
 * End-to-end against a real `node:http` listener on an ephemeral port: the
 * observable behavior is the wire, and the wire is what the spec promises
 * (standard 02: scenario to test mapping at the narrowest layer).
 */

interface Response {
  readonly status: number;
  readonly body: unknown;
}

interface Started {
  readonly server: ApiServer;
  readonly port: number;
  readonly lines: readonly Record<string, unknown>[];
}

const echo: ServiceRoute = {
  method: 'POST',
  path: '/echo',
  requiresBody: true,
  handle: (input: unknown) => Promise.resolve(input),
};

const validate: ServiceRoute = {
  method: 'POST',
  path: '/validate',
  requiresBody: true,
  handle: (input: unknown) => {
    z.object({ n: z.number() }).parse(input);
    return Promise.resolve({ ok: true });
  },
};

const boom: ServiceRoute = {
  method: 'GET',
  path: '/boom',
  requiresBody: false,
  handle: () => Promise.reject(new Error('kaboom')),
};

/** A route that announces arrival, then resolves after a delay: shutdown tests wait for arrival, not for the TCP connect. */
function slowRoute(delayMs: number): { route: ServiceRoute; arrived: Promise<void> } {
  let announce: () => void;
  const arrived = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const route: ServiceRoute = {
    method: 'GET',
    path: '/slow',
    requiresBody: false,
    handle: () => {
      announce();
      return new Promise<unknown>((resolve) => {
        setTimeout(() => {
          resolve({ done: true });
        }, delayMs);
      });
    },
  };
  return { route, arrived };
}

const hang: ServiceRoute = {
  method: 'GET',
  path: '/hang',
  requiresBody: false,
  handle: () =>
    new Promise<unknown>(() => {
      /* never resolves: a hanging request stays pending until shutdown forces the socket */
    }),
};

const started: ApiServer[] = [];

function startServer(
  options: {
    routes?: readonly ServiceRoute[];
    config?: Partial<ApiConfig>;
  } = {},
): Promise<Started> {
  const lines: Record<string, unknown>[] = [];
  const sink: LogSink = {
    write(line) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  const config: ApiConfig = { ...loadApiConfig({}), ...options.config };
  const server = createApiServer(config, sink, options.routes ?? []);
  started.push(server);
  return server.listen(0, '127.0.0.1').then((port) => ({ server, port, lines }));
}

async function closeStarted(): Promise<void> {
  const pending = started.splice(0);
  for (const server of pending) {
    await server.close();
  }
}

function readJson(contentType: string | undefined, chunks: readonly Buffer[]): unknown {
  if (!contentType?.includes('json')) {
    return undefined;
  }
  const raw = Buffer.concat([...chunks]).toString('utf8');
  return raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
}

function call(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
  agent?: Agent,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: agent ?? false,
        headers: { connection: agent === undefined ? 'close' : 'keep-alive', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: readJson(res.headers['content-type'], chunks),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined && headers['transfer-encoding'] === 'chunked') {
      req.write(body);
      req.end();
    } else {
      req.end(body);
    }
  });
}

function dataOf(response: Response): unknown {
  return (response.body as { data?: unknown }).data;
}

/** Narrows an expected log line: `as` and `!` are both barred by the lint baseline. */
function requiredLine(
  lines: readonly Record<string, unknown>[],
  message: string,
): Record<string, unknown> {
  const line = lines.find((entry) => entry['message'] === message);
  if (line === undefined) {
    throw new Error(`expected a log line with message ${message}`);
  }
  return line;
}

function metaOf(response: Response): { request_id: string; trace_id?: string } {
  return (response.body as { meta: { request_id: string; trace_id?: string } }).meta;
}

describe('api server', () => {
  afterEach(closeStarted);
  it('answers the liveness probe without a body', async () => {
    const { port } = await startServer();
    const response = await call(port, 'GET', '/healthz');
    expect(response.status).toBe(200);
    expect(dataOf(response)).toEqual({ status: 'ok' });
  });

  it('ignores a query string when routing', async () => {
    const { port } = await startServer();
    const response = await call(port, 'GET', '/healthz?probe=1');
    expect(response.status).toBe(200);
  });

  it('answers the readiness probe while running', async () => {
    const { port } = await startServer();
    const response = await call(port, 'GET', '/readyz');
    expect(response.status).toBe(200);
    expect(dataOf(response)).toEqual({ status: 'ready' });
  });

  it('echoes the request id and derives the trace id from traceparent', async () => {
    const traceId = 'a'.repeat(32);
    const { port } = await startServer({ routes: [echo] });
    const response = await call(port, 'POST', '/echo', '{"a":1}', {
      'x-request-id': 'req-1',
      traceparent: `00-${traceId}-${'b'.repeat(16)}-01`,
    });
    expect(response.status).toBe(200);
    expect(metaOf(response).request_id).toBe('req-1');
    expect(metaOf(response).trace_id).toBe(traceId);
    expect(dataOf(response)).toEqual({ a: 1 });
  });

  it('mints a request id when none arrives', async () => {
    const { port } = await startServer({ routes: [echo] });
    const response = await call(port, 'POST', '/echo', '{"a":1}');
    expect(typeof metaOf(response).request_id).toBe('string');
  });

  it('treats an empty body as no input', async () => {
    const { port } = await startServer({ routes: [echo] });
    const response = await call(port, 'POST', '/echo', '');
    expect(response.status).toBe(200);
    expect(dataOf(response)).toBeUndefined();
  });

  it('rejects malformed JSON with a 400', async () => {
    const { port } = await startServer({ routes: [echo] });
    const response = await call(port, 'POST', '/echo', '{not json');
    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('BAD_REQUEST');
    expect((response.body as { detail: string }).detail).toBe('Malformed JSON request body.');
  });

  it('rejects a schema violation with per-path issues', async () => {
    const { port } = await startServer({ routes: [validate] });
    const response = await call(port, 'POST', '/validate', '{"n":"x"}');
    expect(response.status).toBe(400);
    expect((response.body as { errors: unknown[] }).errors).toHaveLength(1);
    expect((response.body as { errors: { pointer: string }[] }).errors[0]?.pointer).toBe('/n');
  });

  it('reports a JSON pointer for a nested violation', async () => {
    const nested: ServiceRoute = {
      method: 'POST',
      path: '/nested',
      requiresBody: true,
      handle: (input: unknown) => {
        z.object({ outer: z.object({ inner: z.string() }) }).parse(input);
        return Promise.resolve({ ok: true });
      },
    };
    const { port } = await startServer({ routes: [nested] });
    const response = await call(port, 'POST', '/nested', '{"outer":{"inner":1}}');
    expect(response.status).toBe(400);
    expect((response.body as { errors: { pointer: string }[] }).errors[0]?.pointer).toBe(
      '/outer/inner',
    );
  });

  it('answers 404 for an unknown path', async () => {
    const { port } = await startServer();
    const response = await call(port, 'GET', '/nope');
    expect(response.status).toBe(404);
    expect((response.body as { code: string }).code).toBe('NOT_FOUND');
  });

  it('answers 405 with the allowed methods', async () => {
    const { port } = await startServer();
    const response = await call(port, 'POST', '/healthz');
    expect(response.status).toBe(405);
    expect((response.body as { detail: string }).detail).toBe('Allowed: GET');
  });

  it('refuses an oversized declared body before reading it', async () => {
    const { port } = await startServer({ routes: [echo], config: { max_body_bytes: 1024 } });
    const response = await call(port, 'POST', '/echo', 'x'.repeat(2048));
    expect(response.status).toBe(413);
    expect((response.body as { code: string }).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('refuses an oversized streamed body', async () => {
    const { port } = await startServer({ routes: [echo], config: { max_body_bytes: 4 } });
    const response = await call(port, 'POST', '/echo', 'x'.repeat(64));
    expect(response.status).toBe(413);
  });

  it('refuses an oversized chunked body without a declared length', async () => {
    const { port } = await startServer({ routes: [echo], config: { max_body_bytes: 4 } });
    const response = await call(port, 'POST', '/echo', 'x'.repeat(64), {
      'transfer-encoding': 'chunked',
    });
    expect(response.status).toBe(413);
  });

  it('carries the trace id onto a validation problem', async () => {
    const { port } = await startServer({ routes: [validate] });
    const response = await call(port, 'POST', '/validate', '{"n":"x"}', {
      traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    });
    expect(response.status).toBe(400);
    expect((response.body as { trace_id: string }).trace_id).toBe('a'.repeat(32));
  });

  it('maps an unexpected handler failure to a detail-free 500', async () => {
    const { port, lines } = await startServer({ routes: [boom] });
    const response = await call(port, 'GET', '/boom');
    expect(response.status).toBe(500);
    expect((response.body as { detail?: string }).detail).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('kaboom');
    const failure = requiredLine(lines, 'request failed');
    expect(failure['error_name']).toBe('Error');
  });

  it('logs each handled request', async () => {
    const { port, lines } = await startServer();
    await call(port, 'GET', '/healthz');
    const record = requiredLine(lines, 'request handled');
    expect(record['method']).toBe('GET');
    expect(record['path']).toBe('/healthz');
    expect(record['status']).toBe(200);
    expect(record['request_id']).toBeDefined();
  });

  it('masks log fields the allowlist does not carry', async () => {
    const { port, lines } = await startServer({ config: { log_redaction_allowlist: [] } });
    await call(port, 'GET', '/healthz');
    const handled = requiredLine(lines, 'request handled');
    expect(handled['method']).toBe('[masked]');
  });

  it('rejects a port already in use', async () => {
    const first = await startServer();
    const second = createApiServer(loadApiConfig({}), {
      write() {
        /* discarded: this server never serves a request */
      },
    });
    await expect(second.listen(first.port, '127.0.0.1')).rejects.toThrow();
  });

  it('drains in-flight requests and then refuses new connections', async () => {
    const slow = slowRoute(150);
    const { server, port } = await startServer({ routes: [slow.route] });
    const inflight = call(port, 'GET', '/slow');
    await slow.arrived;
    await server.close();
    expect((await inflight).status).toBe(200);
    await expect(call(port, 'GET', '/healthz')).rejects.toThrow();
  });

  it('stops intake and reports not-ready while shutting down', async () => {
    const slow = slowRoute(150);
    const { server, port } = await startServer({
      routes: [slow.route, echo],
      config: { shutdown_timeout_ms: 500 },
    });
    const agent = new Agent({ keepAlive: true });
    const inflight = call(port, 'GET', '/slow', undefined, {}, agent);
    await slow.arrived;
    const closed = server.close();

    const ready = await call(port, 'GET', '/readyz', undefined, {}, agent);
    expect(ready.status).toBe(503);
    expect(dataOf(ready)).toEqual({ status: 'not_ready' });

    const rejected = await call(port, 'POST', '/echo', '{"a":1}', {}, agent);
    expect(rejected.status).toBe(503);
    expect((rejected.body as { code: string }).code).toBe('SERVICE_UNAVAILABLE');

    expect((await inflight).status).toBe(200);
    await closed;
    agent.destroy();
  });

  it('closes without ever listening', async () => {
    const unlistened = createApiServer(loadApiConfig({}), {
      write() {
        /* never called */
      },
    });
    await unlistened.close();
  });

  it('forces lingering sockets closed after the shutdown timeout', async () => {
    const { server, port } = await startServer({
      routes: [hang],
      config: { shutdown_timeout_ms: 100 },
    });
    const inflight = call(port, 'GET', '/hang');
    await server.close();
    await expect(inflight).rejects.toThrow();
  });
});
