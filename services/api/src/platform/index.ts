import { createApiRuntime } from './composition.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { StructuredLogger, type LogSink } from './logging.js';

const sink: LogSink = {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
};
let logger = new StructuredLogger({ log_level: 'info', log_redaction_allowlist: [] }, sink);

try {
  const config = await loadRuntimeConfig();
  logger = new StructuredLogger(config, sink);
  const runtime = await createApiRuntime(config, sink);
  await runtime.listen();
  logger.info({}, 'API started');
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    logger.info({}, 'API stopping');
    void runtime.close().then(
      () => {
        logger.info({}, 'API stopped');
      },
      () => {
        logger.error({}, 'API shutdown failed');
        process.exitCode = 1;
      },
    );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  logger.error({}, 'API startup failed', {
    error_name: error instanceof Error ? error.name : 'UnknownError',
  });
  process.exitCode = 1;
}
