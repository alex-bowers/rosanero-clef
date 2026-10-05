/** A bad credential or an outage would otherwise retry every item in turn. */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface PendingRun {
  done: number;
  failed: number;
  stoppedEarly: boolean;
}

/**
 * Handles each item in turn. One failure is counted and skipped, so the item is retried on the
 * next run; three in a row stop the run.
 */
export async function processEach<T>(
  items: T[],
  handle: (item: T) => Promise<void>,
  label: (item: T) => string,
): Promise<PendingRun> {
  const run: PendingRun = { done: 0, failed: 0, stoppedEarly: false };
  let consecutiveFailures = 0;

  for (const item of items) {
    try {
      await handle(item);
      run.done++;
      consecutiveFailures = 0;
    } catch (error) {
      console.warn(`${label(item)} failed: ${String(error)}`);
      run.failed++;
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        run.stoppedEarly = true;
        break;
      }
    }
  }
  return run;
}
