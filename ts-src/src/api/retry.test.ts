import { describe, expect, it, vi } from 'vitest';
import { retryWithBackoff } from './retry.js';

describe('retryWithBackoff', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on network error and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue('recovered');

    const result = await retryWithBackoff(fn, { baseDelay: 1 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx errors', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP status: 502'))
      .mockRejectedValueOnce(new Error('HTTP 500: {"error":"205","message":"Upload data failure"}'))
      .mockResolvedValue('ok');

    const result = await retryWithBackoff(fn, { baseDelay: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on 4xx client errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('HTTP status: 401 Unauthorized'));
    await expect(retryWithBackoff(fn, { baseDelay: 1 })).rejects.toThrow('401');
    expect(fn).toHaveBeenCalledTimes(1);

    const fn404 = vi.fn().mockRejectedValue(new Error('HTTP 404: Not Found'));
    await expect(retryWithBackoff(fn404, { baseDelay: 1 })).rejects.toThrow('404');
    expect(fn404).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on non-network errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('SyntaxError: invalid JSON'));
    await expect(retryWithBackoff(fn, { baseDelay: 1 })).rejects.toThrow('SyntaxError');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(retryWithBackoff(fn, { maxRetries: 2, baseDelay: 1 })).rejects.toThrow(
      'ECONNRESET',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects maxRetries=0', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('network error'));
    await expect(retryWithBackoff(fn, { maxRetries: 0, baseDelay: 1 })).rejects.toThrow('network');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on ETIMEDOUT and socket errors', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue('done');

    const result = await retryWithBackoff(fn, { baseDelay: 1 });
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
