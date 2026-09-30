import { type ZodError } from 'zod';

import { createProblemDetails, type ProblemDetails } from '@navis/contracts';

/**
 * Error mapping — every failure the service reports crosses this boundary once.
 *
 * Public failures follow RFC 9457 through the contracts package: a stable
 * machine `code`, a human-safe `title`, and never a stack trace, query text,
 * credential, or internal path (standard 03). A failure this module does not
 * recognize becomes an internal error with no echo of the original message,
 * because that message is untrusted evidence rather than client-facing detail.
 */

/** A failure the service reports with a chosen HTTP status. */
export abstract class ServiceError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
  abstract readonly title: string;
  /** Safe human detail; undefined when the status alone says enough. */
  abstract readonly detail: string | undefined;
  /**
   * Extra public fields the problem carries beyond the RFC 9457 core; empty by
   * default. Reserved for contract negotiation data a client must read
   * machine-side.
   */
  readonly problemExtra: Readonly<Record<string, unknown>> = {};
}

export class BadRequestError extends ServiceError {
  override readonly name = 'BadRequestError' as const;
  readonly status = 400 as const;
  readonly code = 'BAD_REQUEST' as const;
  readonly title = 'Bad Request' as const;
  readonly detail: string | undefined;
  constructor(detail?: string) {
    super('Bad Request');
    this.detail = detail;
  }
}

export class NotFoundError extends ServiceError {
  override readonly name = 'NotFoundError' as const;
  readonly status = 404 as const;
  readonly code = 'NOT_FOUND' as const;
  readonly title = 'Not Found' as const;
  readonly detail = undefined;
  constructor() {
    super('Not Found');
  }
}

export class MethodNotAllowedError extends ServiceError {
  override readonly name = 'MethodNotAllowedError' as const;
  readonly status = 405 as const;
  readonly code = 'METHOD_NOT_ALLOWED' as const;
  readonly title = 'Method Not Allowed' as const;
  readonly detail: string;
  constructor(allowed: readonly string[]) {
    super('Method Not Allowed');
    this.detail = `Allowed: ${allowed.join(', ')}`;
  }
}

/** A missing or invalid device key: the caller must re-authenticate. */
export class UnauthorizedError extends ServiceError {
  override readonly name = 'UnauthorizedError' as const;
  readonly status = 401 as const;
  readonly code = 'UNAUTHORIZED' as const;
  readonly title = 'Unauthorized' as const;
  /** The stable denial token: never reveals whether the key id existed. */
  readonly detail: string;
  constructor(token: 'device-auth/key-invalid' | 'device-auth/device-revoked') {
    super('Unauthorized');
    this.detail = token;
  }
}

/** The key is valid but the participant has no grant on the requested scope. */
export class AuthorizationDeniedError extends ServiceError {
  override readonly name = 'AuthorizationDeniedError' as const;
  readonly status = 403 as const;
  readonly code = 'FORBIDDEN' as const;
  readonly title = 'Forbidden' as const;
  readonly detail = 'device-auth/authorization-denied' as const;
  constructor() {
    super('Forbidden');
  }
}

export class PayloadTooLargeError extends ServiceError {
  override readonly name = 'PayloadTooLargeError' as const;
  readonly status = 413 as const;
  readonly code = 'PAYLOAD_TOO_LARGE' as const;
  readonly title = 'Payload Too Large' as const;
  readonly detail: string;
  constructor(limitBytes: number) {
    super('Payload Too Large');
    this.detail = `Request body exceeds the ${String(limitBytes)}-byte limit.`;
  }
}

export class ServiceUnavailableError extends ServiceError {
  override readonly name = 'ServiceUnavailableError' as const;
  readonly status = 503 as const;
  readonly code = 'SERVICE_UNAVAILABLE' as const;
  readonly title = 'Service Unavailable' as const;
  readonly detail = 'The service is shutting down and is not accepting new work.';
  constructor() {
    super('Service Unavailable');
  }
}

export class InternalServerError extends ServiceError {
  override readonly name = 'InternalServerError' as const;
  readonly status = 500 as const;
  readonly code = 'INTERNAL_ERROR' as const;
  readonly title = 'Internal Server Error' as const;
  readonly detail = undefined;
  constructor(cause: unknown) {
    super('Internal Server Error');
    this.cause = cause;
  }
}

export interface RequestContextLike {
  request_id: string;
  trace_id?: string;
}

/** Problem Details `type` URI for a machine code. Stable across services; does not dereference. */
export class UnsupportedContractVersionError extends ServiceError {
  override readonly name = 'UnsupportedContractVersionError' as const;
  readonly status = 400 as const;
  readonly code = 'UNSUPPORTED_CONTRACT_VERSION' as const;
  readonly title = 'Unsupported Contract Version' as const;
  readonly detail: string;
  override readonly problemExtra: Readonly<Record<string, unknown>>;
  constructor(received: number, supported: readonly number[]) {
    super('Unsupported Contract Version');
    this.detail = `contract_version ${String(received)} is not supported; supported versions: ${supported.join(', ')}`;
    this.problemExtra = { server_supported_contract_versions: [...supported] };
  }
}

export function problemType(code: string): string {
  return `urn:navis:problem:${code.toLowerCase()}`;
}

/**
 * Holds a string inside the wire limit. Issue messages and pointers derive from
 * client-supplied keys and values, so their length is untrusted: an over-long
 * field would make the Problem Details response itself invalid.
 */
function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

/**
 * Maps any thrown value to public Problem Details.
 *
 * Known service errors keep their status and detail; anything else becomes a
 * 500 whose detail is intentionally absent — the original message is logged
 * server-side, never shipped to a client that could probe internals with it.
 */
export function toProblemDetails(error: unknown, context: RequestContextLike): ProblemDetails {
  const serviceError = error instanceof ServiceError ? error : new InternalServerError(error);
  const fields: Record<string, unknown> = {
    type: problemType(serviceError.code),
    title: serviceError.title,
    status: serviceError.status,
    code: serviceError.code,
    request_id: context.request_id,
  };
  if (serviceError.detail !== undefined) {
    fields['detail'] = serviceError.detail;
  }
  for (const [key, value] of Object.entries(serviceError.problemExtra)) {
    fields[key] = value;
  }
  if (context.trace_id !== undefined) {
    fields['trace_id'] = context.trace_id;
  }
  return createProblemDetails(fields);
}

/**
 * Maps a zod validation failure to a 400 with one issue per offending path.
 * Issue codes are deliberately not echoed: zod's lowercase identifiers do not
 * satisfy the public `code` vocabulary, and clients key off the request-level
 * `code` plus the pointer.
 */
export function toValidationProblem(error: ZodError, context: RequestContextLike): ProblemDetails {
  const fields: Record<string, unknown> = {
    type: problemType('BAD_REQUEST'),
    title: 'Bad Request',
    status: 400,
    code: 'BAD_REQUEST',
    detail: 'The request body did not validate.',
    errors: error.issues.map((issue) => ({
      detail: bounded(issue.message, 1024),
      pointer: bounded(`/${issue.path.join('/')}`, 1024),
    })),
    request_id: context.request_id,
  };
  if (context.trace_id !== undefined) {
    fields['trace_id'] = context.trace_id;
  }
  return createProblemDetails(fields);
}
