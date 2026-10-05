export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stops waiting after `ms`. The underlying work is not cancelled, so a result that arrives
 * after the timeout is passed to `onLate`, for example to record its token usage.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onLate?: (result: T) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Timed out after ${ms} ms`));
    }, ms);
  });
  promise.then(
    (result) => {
      if (timedOut) onLate?.(result);
    },
    () => {}, // The race below reports a failure, or it arrived after the timeout and is ignored.
  );
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
