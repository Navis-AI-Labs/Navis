import type { ApiConfig } from './config.js';

/**
 * Structured logging — one JSON object per line.
 *
 * Every line carries the request correlation (`request_id`, `trace_id`) that
 * flows from transport entry down through use cases. Fields the service does
 * not name are masked before writing, so a stray payload, token, or path can
 * only reach a log line through a deliberate allowlist entry (standard 03).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Structural fields the logger itself owns. They are never client content:
 * correlation ids arrive validated from the trace-context module, and the
 * error fields describe a failure this service produced.
 */
const structuralFields = new Set([
  'ts',
  'level',
  'message',
  'request_id',
  'trace_id',
  'error_name',
]);

const maskedValue = '[masked]';

/** Correlation ids plus any structured fields the caller names. */
export interface LogContext {
  request_id?: string;
  trace_id?: string;
  [name: string]: unknown;
}

/** A line destination. `console` is not used from service code, so the sink is injected: tests capture, production writes to stdout. */
export interface LogSink {
  write(line: string): void;
}

export class StructuredLogger {
  readonly #level: LogLevel;
  readonly #allowlist: ReadonlySet<string>;
  readonly #sink: LogSink;

  constructor(config: Pick<ApiConfig, 'log_level' | 'log_redaction_allowlist'>, sink: LogSink) {
    this.#level = config.log_level;
    this.#allowlist = new Set(config.log_redaction_allowlist);
    this.#sink = sink;
  }

  debug(context: LogContext, message: string, extra?: Record<string, unknown>): void {
    this.#emit('debug', context, message, extra);
  }

  info(context: LogContext, message: string, extra?: Record<string, unknown>): void {
    this.#emit('info', context, message, extra);
  }

  warn(context: LogContext, message: string, extra?: Record<string, unknown>): void {
    this.#emit('warn', context, message, extra);
  }

  /** Records a failed outcome that needs attention (standard 03: `error` is not for recoverable conditions). */
  error(context: LogContext, message: string, extra?: Record<string, unknown>): void {
    this.#emit('error', context, message, extra);
  }

  #emit(
    level: LogLevel,
    context: LogContext,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    if (levelRank[level] < levelRank[this.#level]) {
      return;
    }
    const fields: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      message,
    };
    for (const [name, value] of Object.entries(context)) {
      fields[name] = value;
    }
    if (extra !== undefined) {
      for (const [name, value] of Object.entries(extra)) {
        fields[name] = value;
      }
    }
    const safe: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(fields)) {
      safe[name] = structuralFields.has(name) || this.#allowlist.has(name) ? value : maskedValue;
    }
    this.#sink.write(JSON.stringify(safe));
  }
}
