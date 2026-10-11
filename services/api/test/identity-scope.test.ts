import { afterEach, expect, it, vi } from 'vitest';
import * as application from '@navis/application';
import {
  InMemoryDeviceAuth,
  InMemoryEventStore,
  InMemoryProjectDirectory,
} from '@navis/infrastructure';
import { uuidv7 } from '@navis/domain';
import { withDeviceAuth } from '../src/auth/middleware.js';
import { createApiRoutes } from '../src/platform/routes.js';
import * as ingest from '../src/ingest/route.js';

afterEach(() => vi.restoreAllMocks());
it('allows authenticated operations without a project input while retaining identity', async () => {
  const participantId = uuidv7();
  vi.spyOn(application, 'authenticateKey').mockResolvedValue({
    outcome: 'authenticated',
    participant_id: participantId,
    device_id: uuidv7(),
  });
  const sink = vi.fn();
  const handle = vi.fn().mockResolvedValue({ accepted: true });
  const route = withDeviceAuth(
    {
      deviceFlow: {
        store: new InMemoryDeviceAuth(),
        now: () => new Date().toISOString(),
        verificationBaseUrl: 'http://127.0.0.1/device',
      },
      projectDirectory: new InMemoryProjectDirectory(),
    },
    { method: 'GET', path: '/test', requiresBody: false, handle },
    { identitySink: sink },
  );
  await expect(
    route.handle(null, { request_id: uuidv7() }, { authorization: 'Bearer verified' }),
  ).resolves.toEqual({ accepted: true });
  expect(sink).toHaveBeenCalledWith(expect.objectContaining({ participantId }));
});
it('fails closed if the capture callback escapes its authenticated request scope', () => {
  let captured: ingest.IngestRouteDeps | undefined;
  const factory = ingest.ingestRoute;
  vi.spyOn(ingest, 'ingestRoute').mockImplementation((deps) => {
    captured = deps;
    return factory(deps);
  });
  const projects = Object.create(
    application.ProjectService.prototype,
  ) as application.ProjectService;
  createApiRoutes({
    projects,
    eventStore: new InMemoryEventStore(),
    deviceStore: new InMemoryDeviceAuth(),
    projectDirectory: new InMemoryProjectDirectory(),
    now: () => new Date().toISOString(),
    verificationBaseUrl: 'http://127.0.0.1/device',
  });
  if (captured?.canCapture === undefined) throw new Error('capture guard missing');
  expect(() => captured?.canCapture?.(uuidv7())).toThrow('Forbidden');
});
