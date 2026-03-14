import { describe, it, expect } from 'vitest';
import { pLimit, mapConcurrent } from './concurrency.js';

describe('pLimit', () => {
  it('throws when concurrency < 1', () => {
    expect(() => pLimit(0)).toThrow('concurrency must be >= 1');
  });

  it('runs a single task', async () => {
    const limit = pLimit(1);
    const result = await limit(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('limits concurrency to the specified value', async () => {
    let active = 0;
    let maxActive = 0;
    const limit = pLimit(2);

    const task = () =>
      limit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return active;
      });

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxActive).toBe(2);
  });

  it('propagates rejections', async () => {
    const limit = pLimit(1);
    await expect(limit(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  it('continues processing after a rejection', async () => {
    const limit = pLimit(1);
    const results: string[] = [];

    const p1 = limit(() => Promise.reject(new Error('fail'))).catch(() => results.push('caught'));
    const p2 = limit(() => {
      results.push('ok');
      return Promise.resolve();
    });

    await Promise.all([p1, p2]);
    expect(results).toEqual(['caught', 'ok']);
  });
});

describe('mapConcurrent', () => {
  it('maps items through an async function', async () => {
    const result = await mapConcurrent([1, 2, 3], 2, (x) => Promise.resolve(x * 2));
    expect(result).toEqual([2, 4, 6]);
  });

  it('returns empty array for empty input', async () => {
    const result = await mapConcurrent([] as number[], 2, (x) => Promise.resolve(x));
    expect(result).toEqual([]);
  });
});
