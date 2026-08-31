/**
 * Exponential backoff retry for API calls.
 * Matches Python utils.py:retry_with_backoff.
 *
 * Only retries network/server errors (5xx); client errors (4xx) are thrown immediately.
 */

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('fetch') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('socket') ||
      msg.includes('abort')
    ) {
      return true;
    }
    // HTTP status-based: retry 5xx, don't retry 4xx
    const statusMatch = /(?:status[: ]+|http[:\s]+)(\d{3})/.exec(msg);
    if (statusMatch) {
      const cap = statusMatch[1];
      if (cap === undefined) return false;
      const status = parseInt(cap, 10);
      return status >= 500;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; baseDelay?: number },
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelay ?? 1000;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt >= maxRetries) throw e;
      const delay = baseDelay * 2 ** attempt;
      await sleep(delay);
    }
  }

  throw lastErr;
}
