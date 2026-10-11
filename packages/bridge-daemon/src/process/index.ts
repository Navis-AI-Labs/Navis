import { BridgeRuntime } from '../runtime/runtime.js';
const runtime = new BridgeRuntime();
const started = await runtime.start();
if (started.created) {
  const stop = (): void => {
    void runtime.close().catch(() => {
      process.stderr.write('Bridge shutdown failed.\n');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
