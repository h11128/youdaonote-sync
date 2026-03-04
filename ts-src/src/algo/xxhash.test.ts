import { describe, it, expect, beforeAll } from 'vitest';
import { initXxhash, xxh128, xxh64ToString, xxh32ToString, isXxhashReady } from './xxhash.js';

describe('xxhash', () => {
  beforeAll(async () => {
    await initXxhash();
  });

  it('is ready after init', () => {
    expect(isXxhashReady()).toBe(true);
  });

  it('xxh64ToString returns 16-char hex', () => {
    const result = xxh64ToString('hello');
    expect(result).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(result)).toBe(true);
  });

  it('xxh128 returns 32-char hex', () => {
    const result = xxh128('hello');
    expect(result).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(result)).toBe(true);
  });

  it('xxh32ToString returns 8-char hex', () => {
    const result = xxh32ToString('test');
    expect(result).toHaveLength(8);
  });

  it('produces deterministic output', () => {
    expect(xxh64ToString('abc')).toBe(xxh64ToString('abc'));
    expect(xxh128('abc')).toBe(xxh128('abc'));
  });

  it('different inputs produce different hashes', () => {
    expect(xxh64ToString('aaa')).not.toBe(xxh64ToString('bbb'));
  });
});
