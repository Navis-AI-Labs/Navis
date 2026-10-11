import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatModelProvider } from '../src/model/chat-provider.js';
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});
async function endpoint(
  status: number,
  body: string,
  observe?: (input: unknown, headers: Record<string, unknown>) => void,
) {
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    req.on('end', () => {
      observe?.(JSON.parse(text), req.headers);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP listener');
  return `http://127.0.0.1:${String(address.port)}/v1`;
}
describe('model provider boundary', () => {
  it('sends explicit bounded task text without exposing tools', async () => {
    const remote = await endpoint(
      200,
      JSON.stringify({ choices: [{ message: { content: 'candidate' } }] }),
      (input, headers) => {
        expect(input).toMatchObject({ model: 'test-model', max_tokens: 2048, stream: false });
        expect(input).not.toHaveProperty('tools');
        expect(headers['authorization']).toBe('Bearer test-provider-key');
        expect(headers['user-agent']).toBe('Navis/0.0.0');
      },
    );
    const provider = new ChatModelProvider(remote, 'test-model', 'test-provider-key');
    expect(provider.modelName).toBe('test-model');
    await expect(
      provider.generate('propose a plan', 'request-a', new AbortController().signal),
    ).resolves.toBe('candidate');
  });
  it.each([401, 403, 429, 502])(
    'classifies HTTP %i without returning provider content',
    async (status) => {
      const remote = await endpoint(status, 'sensitive upstream detail');
      const call = new ChatModelProvider(remote, 'model', 'secret-provider-key').generate(
        'sensitive input',
        'request-b',
        new AbortController().signal,
      );
      await expect(call).rejects.toMatchObject({
        code: status === 401 || status === 403 ? 'MODEL_CREDENTIAL_DENIED' : 'MODEL_HTTP_FAILURE',
        retryable: status === 429 || status === 502,
      });
      await expect(call).rejects.not.toThrow('sensitive');
    },
  );
  it.each([
    'invalid json',
    JSON.stringify({ choices: [] }),
    JSON.stringify({ choices: [{ message: { content: '' } }] }),
  ])('rejects invalid model output', async (body) => {
    const remote = await endpoint(200, body);
    await expect(
      new ChatModelProvider(remote, 'model', 'secret-provider-key').generate(
        'task',
        'request-c',
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it('bounds response bytes before parsing', async () => {
    const remote = await endpoint(200, 'x'.repeat(262145));
    await expect(
      new ChatModelProvider(remote, 'model', 'secret-provider-key').generate(
        'task',
        'request-d',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'MODEL_RESPONSE_TOO_LARGE' });
  });
  it('rejects empty responses and respects shutdown cancellation', async () => {
    const remote = await endpoint(204, '');
    const provider = new ChatModelProvider(remote, 'model', 'secret-provider-key');
    await expect(
      provider.generate('task', 'request-e', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MODEL_EMPTY_RESPONSE' });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.generate('task', 'request-f', controller.signal)).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      retryable: false,
    });
  });
});
