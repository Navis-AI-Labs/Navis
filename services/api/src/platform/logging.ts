import type { ApiConfig } from './config.js';

/** Writes structured JSON lines, retaining correlation when supplied and masking fields outside the allowed set. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** These fields bypass redaction. Callers must validate correlation identifiers and keep payload content out of them. */
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

  /** Records an outcome requiring attention. */
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
