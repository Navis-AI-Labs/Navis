import { loadApiConfig } from './config.js';
import { createApiServer } from './server.js';

/**
 * Process entry: validate configuration once, wire signal-driven shutdown, and
 * listen. Nothing here is importable — this module exists to run.
 */

const config = loadApiConfig();
const server = createApiServer(config, {
  write(line) {
    process.stdout.write(line);
    process.stdout.write('\n');
  },
});
await server.listen(config.port, config.host);

const stop = (): void => {
  void server.close();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
