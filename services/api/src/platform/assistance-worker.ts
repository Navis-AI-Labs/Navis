import type { AssistanceService } from '@navis/application';

/** One supervised generation at a time; shutdown aborts the current provider request. */
export function startAssistanceWorker(
  service: Pick<AssistanceService, 'tick'>,
  onFailure: () => void,
  intervalMs = 2000,
): { close(): Promise<void> } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const schedule = (): void => {
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      running = service
        .tick(controller.signal)
        .then(() => undefined)
        .catch(onFailure)
        .finally(schedule);
    }, intervalMs);
  };
  schedule();
  return {
    async close() {
      controller.abort();
      clearTimeout(timer);
      await running;
    },
  };
}
