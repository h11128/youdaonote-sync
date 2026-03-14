import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from './store.js';
import { asContentHash, asEpochSeconds, asRelPath } from '../types/common.js';

const TMP = join(tmpdir(), 'hash-cache-test');
const DB_PATH = join(TMP, 'meta.db');

let meta: MetadataStore;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  meta = new MetadataStore(DB_PATH);
});

afterEach(() => {
  meta.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe('getCachedHash / setCachedHash', () => {
  it('returns null when no entry exists', () => {
    const result = meta.getCachedHash(asRelPath('a.md'), asEpochSeconds(100), 50);
    expect(result).toBeNull();
  });

  it('returns cached hash when mtime+size match', () => {
    const hash = asContentHash('abc123');
    meta.setCachedHash(asRelPath('a.md'), asEpochSeconds(100), 50, hash);

    const result = meta.getCachedHash(asRelPath('a.md'), asEpochSeconds(100), 50);
    expect(result).toBe('abc123');
  });

  it('returns null when mtime differs', () => {
    meta.setCachedHash(asRelPath('a.md'), asEpochSeconds(100), 50, asContentHash('abc'));

    const result = meta.getCachedHash(asRelPath('a.md'), asEpochSeconds(200), 50);
    expect(result).toBeNull();
  });

  it('returns null when size differs', () => {
    meta.setCachedHash(asRelPath('a.md'), asEpochSeconds(100), 50, asContentHash('abc'));

    const result = meta.getCachedHash(asRelPath('a.md'), asEpochSeconds(100), 99);
    expect(result).toBeNull();
  });

  it('overwrites entry on same path with new mtime+size', () => {
    meta.setCachedHash(asRelPath('a.md'), asEpochSeconds(100), 50, asContentHash('old'));
    meta.setCachedHash(asRelPath('a.md'), asEpochSeconds(200), 60, asContentHash('new'));

    expect(meta.getCachedHash(asRelPath('a.md'), asEpochSeconds(100), 50)).toBeNull();
    expect(meta.getCachedHash(asRelPath('a.md'), asEpochSeconds(200), 60)).toBe('new');
  });
});

describe('getCachedHashesBulk / setCachedHashesBulk', () => {
  it('returns empty map for empty input', () => {
    expect(meta.getCachedHashesBulk([]).size).toBe(0);
  });

  it('bulk reads match bulk writes', () => {
    meta.setCachedHashesBulk([
      { path: 'a.md', mtime: asEpochSeconds(100), size: 10, hash: asContentHash('h1') },
      { path: 'b.md', mtime: asEpochSeconds(200), size: 20, hash: asContentHash('h2') },
    ]);

    const result = meta.getCachedHashesBulk([
      { relPath: asRelPath('a.md'), mtime: asEpochSeconds(100), size: 10 },
      { relPath: asRelPath('b.md'), mtime: asEpochSeconds(200), size: 20 },
      { relPath: asRelPath('c.md'), mtime: asEpochSeconds(300), size: 30 },
    ]);

    expect(result.size).toBe(2);
    expect(result.get(asRelPath('a.md'))).toBe('h1');
    expect(result.get(asRelPath('b.md'))).toBe('h2');
    expect(result.has(asRelPath('c.md'))).toBe(false);
  });
});

describe('hash cache version invalidation', () => {
  it('cache survives re-open with same algo version', () => {
    meta.setCachedHash(asRelPath('x.md'), asEpochSeconds(1), 10, asContentHash('val'));
    meta.close();

    meta = new MetadataStore(DB_PATH);
    expect(meta.getCachedHash(asRelPath('x.md'), asEpochSeconds(1), 10)).toBe('val');
  });
});
