import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiRuntime } from '../src/platform/composition.js';
import { loadRuntimeConfig } from '../src/platform/runtime-config.js';
import { runOperator } from '../src/platform/operator-command.js';
vi.mock('../src/platform/composition.js', () => ({ createApiRuntime: vi.fn() }));
vi.mock('../src/platform/runtime-config.js', () => ({ loadRuntimeConfig: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
describe('local operator boundary', () => {
  it.each(
    [[], ['--name', 'operator'], ['--name', 'operator', '--kind', 'unknown']].map((args) => ({
      args,
    })),
  )('refuses incomplete operator identity', async ({ args }) => {
    await expect(runOperator(args, () => undefined)).rejects.toThrow('Usage');
    expect(createApiRuntime).not.toHaveBeenCalled();
  });
  it('returns one credential record and always closes the runtime', async () => {
    vi.mocked(loadRuntimeConfig).mockResolvedValue({
      port: 8080,
      host: '127.0.0.1',
      log_level: 'info',
      log_redaction_allowlist: [],
      max_body_bytes: 1024,
      shutdown_timeout_ms: 1000,
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const provision = vi.fn().mockResolvedValue({ device_id: 'test-device' });
    vi.mocked(createApiRuntime).mockImplementation((_config, sink) => {
      sink.write('operator startup');
      return Promise.resolve({ listen: () => Promise.resolve(0), close, provision });
    });
    const output = vi.fn();
    await runOperator(['--name', 'operator', '--kind', 'human'], output);
    expect(provision).toHaveBeenCalledWith('operator', 'human');
    expect(output).toHaveBeenCalledExactlyOnceWith('{"device_id":"test-device"}');
    expect(close).toHaveBeenCalledOnce();
  });
  it('does not fall back to memory provisioning and closes on failure', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createApiRuntime).mockResolvedValue({ listen: () => Promise.resolve(0), close });
    await expect(
      runOperator(['--name', 'operator', '--kind', 'agent'], () => undefined),
    ).rejects.toThrow('durable');
    expect(close).toHaveBeenCalledOnce();
  });
});
