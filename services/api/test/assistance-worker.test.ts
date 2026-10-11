import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAssistanceWorker } from '../src/platform/assistance-worker.js';
afterEach(() => {
  vi.useRealTimers();
});
describe('supervised assistance worker', () => {
  it('does not overlap jobs and cancels the current generation on shutdown', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const tick = vi.fn((value: AbortSignal) => {
      signal = value;
      return new Promise<boolean>((resolve) => {
        value.addEventListener(
          'abort',
          () => {
            resolve(false);
          },
          { once: true },
        );
      });
    });
    const failure = vi.fn();
    const worker = startAssistanceWorker({ tick }, failure, 10);
    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledOnce();
    await worker.close();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
  });
  it('supervises failures and stops pending timers without starting a job', async () => {
    vi.useFakeTimers();
    const failure = vi.fn();
    const tick = vi.fn().mockRejectedValue(new Error('database down'));
    const worker = startAssistanceWorker({ tick }, failure, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(failure).toHaveBeenCalledOnce();
    await worker.close();
    const idle = startAssistanceWorker({ tick }, failure);
    await idle.close();
  });
});
