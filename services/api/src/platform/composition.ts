import type { DeviceAuthPort, EventStore, ProjectDirectory } from '@navis/domain';
import {
  createConnection,
  InMemoryDeviceAuth,
  InMemoryEventStore,
  InMemoryProjectDirectory,
  PostgresDeviceAuth,
  PostgresEventStore,
  PostgresProjectDirectory,
  runMigrations,
} from '@navis/infrastructure';

import type { ApiConfig } from './config.js';
import type { LogSink } from './logging.js';
import { createApiRoutes } from './routes.js';
import { createApiServer } from './server.js';

export interface ApiRuntime {
  listen(): Promise<number>;
  close(): Promise<void>;
}

/** Owns the adapters and releases them after HTTP intake has drained. */
export async function createApiRuntime(config: ApiConfig, sink: LogSink): Promise<ApiRuntime> {
  let eventStore: EventStore;
  let deviceStore: DeviceAuthPort;
  let projectDirectory: ProjectDirectory;
  let closeStores = (): Promise<void> => Promise.resolve();

  try {
    if (config.database_url === undefined) {
      eventStore = new InMemoryEventStore();
      deviceStore = new InMemoryDeviceAuth();
      projectDirectory = new InMemoryProjectDirectory();
    } else {
      const sql = createConnection(config.database_url);
      closeStores = () => sql.end({ timeout: config.shutdown_timeout_ms / 1000 });
      await runMigrations(sql);
      eventStore = new PostgresEventStore(sql);
      deviceStore = new PostgresDeviceAuth(sql);
      projectDirectory = new PostgresProjectDirectory(sql);
    }

    const routes = createApiRoutes({
      eventStore,
      deviceStore,
      projectDirectory,
      now: () => new Date().toISOString(),
      verificationBaseUrl: `http://${config.host}:${String(config.port)}`,
    });
    const server = createApiServer(config, sink, routes);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= server.close().finally(closeStores);
      return closing;
    };

    return {
      async listen() {
        try {
          return await server.listen(config.port, config.host);
        } catch (error) {
          await close();
          throw error;
        }
      },
      close,
    };
  } catch (error) {
    await closeStores();
    throw error;
  }
}
