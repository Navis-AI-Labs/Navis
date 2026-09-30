import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { createSuccessResponse } from '@navis/contracts';
import { ZodError } from 'zod';

import type { ApiConfig } from './config.js';
import {
  BadRequestError,
  MethodNotAllowedError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceError,
  ServiceUnavailableError,
  toProblemDetails,
  toValidationProblem,
  type RequestContextLike,
} from '../platform/errors.js';
import { StructuredLogger, type LogContext, type LogSink } from './logging.js';
import {
  extractRequestContext,
  freshRequestContext,
  traceIdFromParent,
  type RequestContext,
} from './tracing.js';

/**
 * HTTP transport — a thin `node:http` adapter over public contracts (ADR-0011).
 *
 * No framework dispatches, serializes, or maps errors on our behalf: the route
 * table is keyed by `METHOD + path`, the body reader is bounded, and every
 * status code plus Problem Details body is produced by code this repository
 * owns and tests. Business handlers receive already-parsed input and return
 * plain values; they never touch transport internals.
 */

/**
 * The native handle behind a listening server. `node:http` exposes it without
 * a type; only the closer is needed, so the surface stays minimal.
 */
interface ListenHandle {
  close(): void;
}

/**
 * A business route: method, path (literal or with `:param` segments), whether
 * it needs a body, and its handler. Path params — only `:projectId` today —
 * are extracted into the handler input, never read from the query string.
 */
export interface ServiceRoute {
  readonly method: string;
  readonly path: string;
  readonly requiresBody: boolean;
  /**
   * `headers` carries the raw request headers for routes that authenticate
   * the caller (the Authorization header is a credential transport, never
   * part of the contract body). Routes that ignore it see no change.
   */
  handle(
    input: unknown,
    context: RequestContext,
    headers?: Record<string, string | string[] | undefined>,
  ): Promise<unknown>;
}

export class ApiServer {
  readonly #routes: readonly ServiceRoute[];
  readonly #logger: StructuredLogger;
  readonly #maxBodyBytes: number;
  readonly #shutdownTimeoutMs: number;
  readonly #httpServer: Server;
  readonly #sockets = new Set<Socket>();
  #isShuttingDown = false;
  #listenHandle: ListenHandle | null = null;

  readonly #healthz: ServiceRoute = {
    method: 'GET',
    path: '/healthz',
    requiresBody: false,
    handle() {
      return Promise.resolve({ status: 'ok' });
    },
  };

  constructor(config: ApiConfig, logger: StructuredLogger, routes: readonly ServiceRoute[] = []) {
    this.#logger = logger;
    this.#maxBodyBytes = config.max_body_bytes;
    this.#shutdownTimeoutMs = config.shutdown_timeout_ms;
    const readyz: ServiceRoute = {
      method: 'GET',
      path: '/readyz',
      requiresBody: false,
      handle: () => Promise.resolve({ status: this.#isShuttingDown ? 'not_ready' : 'ready' }),
    };
    this.#routes = [this.#healthz, readyz, ...routes];
    this.#httpServer = createServer((req, res) => {
      void this.#handle(req, res);
    });
    this.#httpServer.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => {
        this.#sockets.delete(socket);
      });
    });
  }

  listen(port: number, host: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        reject(error);
      };
      this.#httpServer.once('error', onError);
      this.#httpServer.listen(port, host, () => {
        this.#httpServer.removeListener('error', onError);
        const address = this.#httpServer.address();
        resolve(address !== null && typeof address === 'object' ? address.port : port);
      });
    });
  }

  /**
   * Graceful shutdown: stop intake, drain in-flight requests, close the port.
   * The readiness probe flips first so a load balancer stops sending traffic;
   * a bounded timeout keeps a stuck request from wedging the process,
   * destroying lingering sockets when it elapses (standard 12).
   *
   * The listening socket is held until the drain finishes: closing it up front
   * would also refuse new connections queued behind the accept loop, which
   * would defeat a drain under any real load.
   */
  close(): Promise<void> {
    if (this.#isShuttingDown) {
      return Promise.resolve();
    }
    this.#isShuttingDown = true;
    // Detach the listening socket before asking the server to drain: the
    // server's own closer would drop it, and with it every connection already
    // queued behind the accept loop. The handle is held here and closed when
    // draining finishes.
    const serverHandle = this.#httpServer as unknown as {
      _handle: ListenHandle | null | undefined;
    };
    const handle = serverHandle._handle;
    if (handle !== undefined && handle !== null) {
      serverHandle._handle = undefined;
      this.#listenHandle = handle;
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        const handle = this.#listenHandle;
        if (handle !== null) {
          this.#listenHandle = null;
          handle.close();
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const timer = setTimeout(() => {
        for (const socket of this.#sockets) {
          socket.destroy();
        }
        finish();
      }, this.#shutdownTimeoutMs);
      this.#httpServer.close(() => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const context = extractRequestContext(req.headers) ?? freshRequestContext();
    const traceId = traceIdFromParent(context.trace_parent);
    const logContext: LogContext = { request_id: context.request_id };
    if (traceId !== undefined) {
      logContext.trace_id = traceId;
    }

    try {
      const route = this.#lookupRoute(req);
      const isProbe = route.path === '/healthz' || route.path === '/readyz';
      if (this.#isShuttingDown && !isProbe) {
        throw new ServiceUnavailableError();
      }
      // path params are authoritative for identity and ride into the body
      // too, so a parameterized POST/DELETE route sees `:segment` values
      // alongside the payload it parses against the contract
      const bodyInput = route.requiresBody ? await this.#readBody(req) : undefined;
      const pathInput = this.#readPathParams(route, req);
      const input =
        bodyInput !== undefined && typeof bodyInput === 'object' && !Array.isArray(bodyInput)
          ? { ...bodyInput, ...pathInput }
          : (bodyInput ?? pathInput);
      const data = await route.handle(input, context, req.headers);
      const meta: { request_id: string; trace_id?: string } = { request_id: context.request_id };
      if (traceId !== undefined) {
        meta.trace_id = traceId;
      }
      const notReady = isProbe && route.path === '/readyz' && this.#isShuttingDown;
      this.#sendJson(res, notReady ? 503 : 200, createSuccessResponse(data, meta));
      this.#logOutcome('request handled', logContext, req, notReady ? 503 : 200, started);
    } catch (error) {
      this.#handleError(error, context, logContext, req, res, started);
    }
  }

  #lookupRoute(req: IncomingMessage): ServiceRoute {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const exact = this.#routes.find((route) => route.path === path && route.method === req.method);
    if (exact !== undefined) {
      return exact;
    }
    // a parameterized route (`:segment`) matches when the literal segments
    // agree and every parameter segment is non-empty
    const parameterized = this.#routes.find((route) => {
      if (!route.path.includes(':')) return false;
      return this.#matchesPattern(route.path, path) && route.method === req.method;
    });
    if (parameterized !== undefined) {
      return parameterized;
    }
    if (this.#routes.some((route) => route.path === path)) {
      const allowed = this.#routes
        .filter((route) => route.path === path)
        .map((route) => route.method);
      throw new MethodNotAllowedError(allowed);
    }
    throw new NotFoundError();
  }

  #matchesPattern(pattern: string, path: string): boolean {
    const patternSegments = pattern.split('/');
    const pathSegments = path.split('/');
    /* v8 ignore next 1 -- the router only forwards same-depth segments */
    if (patternSegments.length !== pathSegments.length) return false;
    return patternSegments.every((segment, index) => {
      const candidate = pathSegments[index];
      /* v8 ignore next 1 -- the depth check above guarantees the segment exists */
      if (candidate === undefined) return false;
      if (segment.startsWith(':')) return candidate.length > 0;
      return segment === candidate;
    });
  }

  /**
   * Extracts path params and query-string fields into the handler input. Path
   * params are authoritative for identity (`:projectId`); the query string
   * carries filters, cursors, and limits. A route with neither receives
   * `undefined`, exactly as before.
   */
  #readPathParams(route: ServiceRoute, req: IncomingMessage): Record<string, unknown> | undefined {
    const url = req.url ?? '/';
    const qIndex = url.indexOf('?');
    const path = qIndex === -1 ? url : url.slice(0, qIndex);
    const query = qIndex === -1 ? '' : url.slice(qIndex + 1);
    if (!route.path.includes(':') && query === '') return undefined;
    const params: Record<string, unknown> = {};
    route.path.split('/').forEach((segment, index) => {
      if (segment.startsWith(':')) {
        const value = path.split('/')[index];
        if (value !== undefined) params[segment.slice(1)] = value;
      }
    });
    if (query !== '') {
      // repeated keys become arrays (`?types=a&types=b`); the contracts layer
      // validates the shape, the transport just decodes it
      for (const pair of query.split('&')) {
        const eq = pair.indexOf('=');
        /* v8 ignore next 1 -- a bare query token without '=' is dropped intentionally */
        if (eq === -1) continue;
        const key = decodeURIComponent(pair.slice(0, eq).replace(/\+/gu, ' '));
        const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/gu, ' '));
        const existing = params[key];
        if (existing === undefined) {
          params[key] = value;
        } else if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          params[key] = [existing, value];
        }
      }
    }
    return params;
  }

  /**
   * Reads a JSON body. The content-length check refuses an oversized request
   * before a single byte is buffered; the running total guards against a
   * header that lies or is absent (standard 10: no unbounded buffering).
   */
  #readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const declared = req.headers['content-length'];
      if (declared !== undefined) {
        const contentLength = Number(declared);
        if (Number.isFinite(contentLength) && contentLength > this.#maxBodyBytes) {
          reject(new PayloadTooLargeError(this.#maxBodyBytes));
          return;
        }
      }
      const chunks: Buffer[] = [];
      let received = 0;
      let oversized = false;
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > this.#maxBodyBytes) {
          oversized = true;
          reject(new PayloadTooLargeError(this.#maxBodyBytes));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (oversized) {
          return;
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.length === 0) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw) as unknown);
        } catch {
          reject(new BadRequestError('Malformed JSON request body.'));
        }
      });
      req.on('error', reject);
    });
  }

  #handleError(
    error: unknown,
    context: RequestContext,
    logContext: LogContext,
    req: IncomingMessage,
    res: ServerResponse,
    started: number,
  ): void {
    const isValidation = error instanceof ZodError;
    const requestContext: RequestContextLike = { request_id: context.request_id };
    if (logContext.trace_id !== undefined) {
      requestContext.trace_id = logContext.trace_id;
    }
    const problem = isValidation
      ? toValidationProblem(error, requestContext)
      : toProblemDetails(error, requestContext);
    const status = problem.status;
    this.#sendJson(res, status, problem, 'application/problem+json');
    const extra: Record<string, unknown> = {};
    if (!isValidation && !(error instanceof ServiceError)) {
      extra['error_name'] = error instanceof Error ? error.name : typeof error;
    }
    this.#logOutcome(
      status >= 500 ? 'request failed' : 'request rejected',
      logContext,
      req,
      status,
      started,
      extra,
    );
  }

  #logOutcome(
    message: string,
    logContext: LogContext,
    req: IncomingMessage,
    status: number,
    started: number,
    extra: Record<string, unknown> = {},
  ): void {
    const fields: Record<string, unknown> = {
      method: req.method,
      path: req.url,
      status,
      duration_ms: Date.now() - started,
      ...extra,
    };
    if (status >= 500) {
      this.#logger.error(logContext, message, fields);
    } else if (status >= 400) {
      this.#logger.warn(logContext, message, fields);
    } else {
      this.#logger.info(logContext, message, fields);
    }
  }

  #sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    contentType = 'application/json',
  ): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(payload).toString(),
    });
    res.end(payload);
  }
}

/** Composes the server: configuration is validated once, at startup, by the caller. */
export function createApiServer(
  config: ApiConfig,
  sink: LogSink,
  routes: readonly ServiceRoute[] = [],
): ApiServer {
  const logger = new StructuredLogger(config, sink);
  return new ApiServer(config, logger, routes);
}
