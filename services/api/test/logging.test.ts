import { describe, expect, it } from 'vitest';

import { StructuredLogger, type LogSink } from '../src/platform/logging.js';

function capturingSink(): { sink: LogSink; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return {
    sink: {
      write(line) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
    lines,
  };
}

function onlyLine(lines: Record<string, unknown>[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  const line = lines[0];
  if (line === undefined) {
    throw new Error('expected exactly one log line');
  }
  return line;
}

describe('StructuredLogger', () => {
  it('writes one structured JSON line per call with correlation fields', () => {
    const { sink, lines } = capturingSink();
    const logger = new StructuredLogger({ log_level: 'info', log_redaction_allowlist: [] }, sink);

    logger.info({ request_id: 'req-1' }, 'request handled');

    const line = onlyLine(lines);
    expect(line['level']).toBe('info');
    expect(line['message']).toBe('request handled');
    expect(line['request_id']).toBe('req-1');
    expect(typeof line['ts']).toBe('string');
  });

  it('keeps debug and info out when the threshold is warn', () => {
    const { sink, lines } = capturingSink();
    const logger = new StructuredLogger({ log_level: 'warn', log_redaction_allowlist: [] }, sink);

    logger.debug({ request_id: 'r' }, 'dropped');
    logger.info({ request_id: 'r' }, 'dropped');
    logger.warn({ request_id: 'r' }, 'kept');
    logger.error({ request_id: 'r' }, 'kept');

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line['level'])).toEqual(['warn', 'error']);
  });

  it('masks every field that is not structural or allowlisted', () => {
    const { sink, lines } = capturingSink();
    const logger = new StructuredLogger(
      { log_level: 'info', log_redaction_allowlist: ['method'] },
      sink,
    );

    logger.info({ request_id: 'r' }, 'm', { method: 'GET', path: '/x', secret: 'token' });

    const line = onlyLine(lines);
    expect(line['method']).toBe('GET');
    expect(line['path']).toBe('[masked]');
    expect(line['secret']).toBe('[masked]');
  });

  it('emits structural fields without an allowlist entry', () => {
    const { sink, lines } = capturingSink();
    const logger = new StructuredLogger({ log_level: 'info', log_redaction_allowlist: [] }, sink);

    logger.info({ request_id: 'r', trace_id: 'a'.repeat(32) }, 'm');

    const line = onlyLine(lines);
    expect(line['request_id']).toBe('r');
    expect(line['trace_id']).toBe('a'.repeat(32));
  });

  it('carries extra structured fields', () => {
    const { sink, lines } = capturingSink();
    const logger = new StructuredLogger(
      { log_level: 'info', log_redaction_allowlist: ['duration_ms'] },
      sink,
    );

    logger.info({ request_id: 'r' }, 'm', { duration_ms: 12 });

    expect(onlyLine(lines)['duration_ms']).toBe(12);
  });
});
