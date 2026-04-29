import { sleep } from "@wiggler/lib/util/sleep";

export type RetryOptions = Readonly<{
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  factor?: number;
  signal?: AbortSignal;
}>;

/**
 * Retries an async operation with exponential backoff up to `attempts` times.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const factor = options.factor ?? 2;
  let delay = options.initialDelayMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts) {
        break;
      }
      await sleep(delay, options.signal);
      delay = Math.min(delay * factor, options.maxDelayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`withRetry exhausted: ${String(lastError)}`);
}
