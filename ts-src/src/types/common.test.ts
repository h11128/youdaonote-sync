import { describe, expect, it } from 'vitest';
import {
  joinRelPath,
  asFileId,
  asDirId,
  asContentHash,
  asRelPath,
  asEpochSeconds,
  asEpochMs,
  nowSeconds,
  nowMs,
  msToSeconds,
} from './common.js';
import type { EpochMs, RelPath } from './common.js';

describe('joinRelPath', () => {
  it('returns segment when base is empty', () => {
    expect(joinRelPath('', 'a')).toBe('a');
  });

  it('joins base and segment with slash', () => {
    expect(joinRelPath('base' as RelPath, 'seg')).toBe('base/seg');
  });
});

describe('msToSeconds', () => {
  it('floors milliseconds to seconds', () => {
    expect(msToSeconds(1500 as EpochMs)).toBe(1);
  });

  it('returns 0 for 0 ms', () => {
    expect(msToSeconds(0 as EpochMs)).toBe(0);
  });
});

describe('nowSeconds', () => {
  it('returns value close to Math.floor(Date.now()/1000)', () => {
    const before = Math.floor(Date.now() / 1000);
    const result = nowSeconds();
    const after = Math.floor(Date.now() / 1000);
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after + 1);
  });
});

describe('nowMs', () => {
  it('returns value close to Date.now()', () => {
    const before = Date.now();
    const result = nowMs();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after + 10);
  });
});

describe('as* constructors', () => {
  it('asFileId returns same value', () => {
    const s = 'file-123';
    expect(asFileId(s)).toBe(s);
  });

  it('asDirId returns same value', () => {
    const s = 'dir-456';
    expect(asDirId(s)).toBe(s);
  });

  it('asContentHash returns same value', () => {
    const s = 'abc123';
    expect(asContentHash(s)).toBe(s);
  });

  it('asRelPath returns same value', () => {
    const s = 'notes/doc.md';
    expect(asRelPath(s)).toBe(s);
  });

  it('asEpochSeconds returns same value', () => {
    const n = 12345;
    expect(asEpochSeconds(n)).toBe(n);
  });

  it('asEpochMs returns same value', () => {
    const n = 12345678;
    expect(asEpochMs(n)).toBe(n);
  });
});
