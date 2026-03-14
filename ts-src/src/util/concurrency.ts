/**
 * Lightweight concurrency limiter — no external dependencies.
 * Equivalent to p-limit: caps the number of promises running at once.
 */

export type LimitFn = <T>(fn: () => Promise<T>) => Promise<T>;

export function pLimit(concurrency: number): LimitFn {
  if (concurrency < 1) throw new Error('concurrency must be >= 1');
  const queue: (() => void)[] = [];
  let active = 0;

  function next(): void {
    if (queue.length > 0 && active < concurrency) {
      active++;
      const run = queue.shift();
      if (run) run();
    }
  }

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

/**
 * Map an array through an async function with bounded concurrency.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(concurrency);
  return Promise.all(items.map((item) => limit(() => fn(item))));
}
