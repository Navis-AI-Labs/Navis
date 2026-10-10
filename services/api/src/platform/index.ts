import { createApiRuntime } from './composition.js';
import { loadApiConfig } from './config.js';

const runtime = await createApiRuntime(loadApiConfig(), {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
await runtime.listen();

const stop = (): void => {
  void runtime.close().catch(() => {
    process.stderr.write('API shutdown failed.\n');
    process.exitCode = 1;
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
