import { ProjectService, AssistanceService, provisionDevice } from '@navis/application';
import type { DeviceAuthPort, EventStore, ProjectDirectory } from '@navis/domain';
import {
  createConnection,
  createDeviceAuthTransaction,
  ChatModelProvider,
  PostgresAssistanceJobs,
  InMemoryDeviceAuth,
  InMemoryEventStore,
  InMemoryProjectDirectory,
  PostgresDeviceAuth,
  PostgresProjectWorkspace,
  PostgresEventStore,
  LOCAL_LEDGER_BYTES,
  PostgresProjectDirectory,
  probeConnection,
  runMigrations,
} from '@navis/infrastructure';

import { startAssistanceWorker } from './assistance-worker.js';
import type { ApiConfig } from './config.js';
import type { LogSink } from './logging.js';
import { createApiRoutes } from './routes.js';
import { createApiServer } from './server.js';

export interface ApiRuntime {
  readonly projects?: ProjectService;
  readonly provision?: (
    name: string,
    kind: 'human' | 'agent',
  ) => ReturnType<typeof provisionDevice>;
  readonly assistance?: AssistanceService;
  listen(): Promise<number>;
  close(): Promise<void>;
}

/** Owns the adapters and releases them after HTTP intake has drained. */
export async function createApiRuntime(config: ApiConfig, sink: LogSink): Promise<ApiRuntime> {
  let eventStore: EventStore;
  let projects: ProjectService | undefined;
  let provision: ApiRuntime['provision'];
  let assistance: AssistanceService | undefined;
  let worker: ReturnType<typeof startAssistanceWorker> | undefined;
  let readiness: (() => Promise<void>) | undefined;
  let deviceStore: DeviceAuthPort;
  let deviceAuthTransaction: ReturnType<typeof createDeviceAuthTransaction> | undefined;
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
      eventStore = new PostgresEventStore(
        sql,
        false,
        config.max_ledger_bytes ?? LOCAL_LEDGER_BYTES,
      );
      const workspace = new PostgresProjectWorkspace(
        sql,
        config.max_ledger_bytes ?? LOCAL_LEDGER_BYTES,
      );
      const now = (): string => new Date().toISOString();
      projects = new ProjectService(workspace, now);
      provision = (name, kind) => provisionDevice(workspace, now, name, kind);
      readiness = () => probeConnection(sql);
      if (config.model !== undefined)
        assistance = new AssistanceService(
          new PostgresAssistanceJobs(sql, config.model.daily_limit, config.model.pending_limit),
          projects,
          new ChatModelProvider(config.model.base_url, config.model.name, config.model.key),
        );
      deviceStore = new PostgresDeviceAuth(sql);
      deviceAuthTransaction = createDeviceAuthTransaction(sql);
      projectDirectory = new PostgresProjectDirectory(sql);
    }

    const routes = createApiRoutes({
      eventStore,
      ...(projects === undefined ? {} : { projects }),
      ...(assistance === undefined ? {} : { assistance }),
      deviceStore,
      ...(deviceAuthTransaction === undefined ? {} : { deviceAuthTransaction }),
      projectDirectory,
      now: () => new Date().toISOString(),
      verificationBaseUrl: `http://${config.host}:${String(config.port)}`,
    });
    const server = createApiServer(config, sink, routes, readiness);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= server
        .close()
        .then(async () => {
          await worker?.close();
        })
        .finally(closeStores);
      return closing;
    };

    return {
      ...(provision === undefined ? {} : { provision }),
      ...(projects === undefined ? {} : { projects }),
      ...(assistance === undefined ? {} : { assistance }),
      async listen() {
        try {
          const port = await server.listen(config.port, config.host);
          if (assistance !== undefined)
            worker = startAssistanceWorker(assistance, () => {
              sink.write(JSON.stringify({ level: 'error', message: 'model worker failed' }));
            });
          return port;
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
