import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../metadata/store.js';
import { asEpochSeconds, asFileId, asRelPath } from '../types/common.js';
import type { DirId, FileId, RelPath } from '../types/common.js';
import {
  tryCachedCloudScan,
  loadCloudFilesFromCache,
  saveScanVersion,
  STATE_LAST_FULL_SCAN,
} from './cloud-cache.js';
import type { CloudFile } from '../types/scan.js';

const TMP = join(tmpdir(), 'cloud-cache-test');
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

function makeEntry(
  id: string,
  name: string,
  version: number,
  opts: { parentId?: string; dir?: boolean; domain?: number; mtime?: number } = {},
): Record<string, unknown> {
  return {
    fileEntry: {
      id,
      name,
      version,
      parentId: opts.parentId ?? 'root',
      dir: opts.dir ?? false,
      domain: opts.domain ?? 0,
      modifyTimeForSort: opts.mtime ?? 1000,
      createTimeForSort: 500,
    },
  };
}

function makeCloudFile(id: string, name: string, parentId = 'root'): CloudFile {
  return {
    id: id as FileId,
    parentId: parentId as DirId,
    name,
    isDir: false,
    mtime: asEpochSeconds(1000),
    ctime: asEpochSeconds(500),
    domain: 0 as never,
  };
}

describe('tryCachedCloudScan: basic caching', () => {
  it('returns null when no cached version exists', async () => {
    const api = { listRecent: () => Promise.resolve([] as Record<string, unknown>[]) };
    const result = await tryCachedCloudScan({
      api,
      meta,
      skipDesktopSeed: true,
      cacheTtlSeconds: 0,
    });
    expect(result).toBeNull();
  });

  it('returns cached data when cloud has no changes', async () => {
    const snap = new Map<RelPath, CloudFile>();
    snap.set(asRelPath('doc.md'), makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);

    const api = { listRecent: () => Promise.resolve([] as Record<string, unknown>[]) };
    const result = await tryCachedCloudScan({
      api,
      meta,
      skipDesktopSeed: true,
      cacheTtlSeconds: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.has(asRelPath('doc.md'))).toBe(true);
  });

  it('returns cached data when cloud version matches', async () => {
    const snap = new Map<RelPath, CloudFile>();
    snap.set(asRelPath('doc.md'), makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);

    const api = {
      listRecent: () => Promise.resolve([makeEntry('f-1', 'doc.note', 10)]),
    };
    const result = await tryCachedCloudScan({
      api,
      meta,
      skipDesktopSeed: true,
      cacheTtlSeconds: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.has(asRelPath('doc.md'))).toBe(true);
  });

  it('updates existing file when cloud version increases', async () => {
    const snap = new Map<RelPath, CloudFile>();
    snap.set(asRelPath('doc.md'), makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);

    const api = {
      listRecent: () =>
        Promise.resolve([
          makeEntry('f-1', 'doc.note', 10),
          makeEntry('f-1', 'doc.note', 15, { mtime: 2000 }),
        ]),
    };
    const result = await tryCachedCloudScan({
      api,
      meta,
      skipDesktopSeed: true,
      cacheTtlSeconds: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.get(asRelPath('doc.md'))!.mtime).toBe(2000);
  });
});

describe('tryCachedCloudScan: incremental new entries', () => {
  it('adds new file via parentId resolution', async () => {
    meta.setDirInfo(asRelPath(''), 'root' as DirId, null);
    meta.setDirInfo(asRelPath('notes'), 'dir-notes' as DirId, 'root' as DirId);

    const snap = new Map<RelPath, CloudFile>();
    snap.set(asRelPath('notes/old.md'), makeCloudFile('f-1', 'old.note', 'dir-notes'));
    saveScanVersion(meta, snap, 10);

    const api = {
      listRecent: () =>
        Promise.resolve([
          makeEntry('f-1', 'old.note', 10, { parentId: 'dir-notes' }),
          makeEntry('f-new', 'brand-new.note', 15, { parentId: 'dir-notes' }),
        ]),
    };
    const result = await tryCachedCloudScan({
      api,
      meta,
      skipDesktopSeed: true,
      cacheTtlSeconds: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.has(asRelPath('notes/brand-new.md'))).toBe(true);
    expect(result!.get(asRelPath('notes/brand-new.md'))!.id).toBe('f-new');
  });

  it('adds new directory via parentId resolution', async () => {
    meta.setDirInfo(asRelPath(''), 'root' as DirId, null);

    const snap = new Map<RelPath, CloudFile>();
    snap.set(asRelPath('existing.md'), makeCloudFile('f-1', 'existing.note'));
    saveScanVersion(meta, snap, 10);

    const api = {
      listRecent: () =>
        Promise.resolve([
          makeEntry('f-1', 'existing.note', 10, { parentId: 'root' }),
          makeEntry('dir-photos', 'photos', 15, { parentId: 'root', dir: true }),
        ]),
    };
    const result = await tryCachedCloudScan({
      api,
      meta,
      skipDesktopSeed: true,
      cacheTtlSeconds: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.has(asRelPath('photos'))).toBe(true);
    expect(result!.get(asRelPath('photos'))!.isDir).toBe(true);
  });

  it('skips new file when parentId cannot be resolved', async () => {
    const snap = new Map<RelPath, CloudFile>();
    snap.set(asRelPath('doc.md'), makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);

    const api = {
      listRecent: () =>
        Promise.resolve([
          makeEntry('f-1', 'doc.note', 10),
          makeEntry('f-orphan', 'orphan.note', 15, { parentId: 'unknown-dir' }),
        ]),
    };
    const result = await tryCachedCloudScan({
      api,
      meta,
      skipDesktopSeed: true,
      cacheTtlSeconds: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.has(asRelPath('doc.md'))).toBe(true);
    expect([...result!.keys()].some((k) => k.includes('orphan'))).toBe(false);
  });
});

describe('tryCachedCloudScan: error handling and overflow', () => {
  it('returns null when all recent entries are newer (overflow)', async () => {
    const snap = new Map<RelPath, CloudFile>();
    snap.set(asRelPath('doc.md'), makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 5);

    const entries = Array.from({ length: 30 }, (_, i) =>
      makeEntry(`f-${i}`, `file${i}.note`, 10 + i),
    );
    const api = { listRecent: () => Promise.resolve(entries) };
    const result = await tryCachedCloudScan({
      api,
      meta,
      skipDesktopSeed: true,
      cacheTtlSeconds: 0,
    });
    expect(result).toBeNull();
  });

  it('falls back to cached data on API error', async () => {
    const snap = new Map<RelPath, CloudFile>();
    snap.set(asRelPath('doc.md'), makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);

    const api = {
      listRecent: () => Promise.reject(new Error('network')),
    };
    const result = await tryCachedCloudScan({
      api,
      meta,
      skipDesktopSeed: true,
      cacheTtlSeconds: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.has(asRelPath('doc.md'))).toBe(true);
  });
});

describe('loadCloudFilesFromCache', () => {
  it('returns null when no files cached', () => {
    expect(loadCloudFilesFromCache(meta)).toBeNull();
  });

  it('skips .conflict. files', () => {
    meta.cacheCloudFileInfo(asRelPath('doc.md'), {
      fileId: 'f-1' as FileId,
      cloudMtime: asEpochSeconds(100),
      parentId: 'root' as DirId,
      domain: 0,
      createTime: asEpochSeconds(50),
    });
    meta.cacheCloudFileInfo(asRelPath('doc.conflict.md'), {
      fileId: 'f-2' as FileId,
      cloudMtime: asEpochSeconds(200),
      parentId: 'root' as DirId,
      domain: 0,
      createTime: asEpochSeconds(50),
    });
    const result = loadCloudFilesFromCache(meta);
    expect(result).not.toBeNull();
    expect(result!.has(asRelPath('doc.md'))).toBe(true);
    expect(result!.has(asRelPath('doc.conflict.md'))).toBe(false);
  });

  it('restores official-app .note name for NOTE-domain local .md paths', () => {
    meta.cacheCloudFileInfo(asRelPath('内在世界/日记/2026/2026年8月13日.md'), {
      fileId: 'WEB-note' as FileId,
      cloudMtime: asEpochSeconds(100),
      parentId: 'root' as DirId,
      domain: 0,
      createTime: asEpochSeconds(50),
    });
    const result = loadCloudFilesFromCache(meta);
    expect(result?.get(asRelPath('内在世界/日记/2026/2026年8月13日.md'))?.name).toBe(
      '2026年8月13日.note',
    );
  });
});

describe('tryCachedCloudScan: 24h full scan interval', () => {
  it('returns null when last full scan was >24h ago', async () => {
    const snap = new Map<RelPath, CloudFile>();
    snap.set(asRelPath('doc.md'), makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);

    const oldTime = Math.floor(Date.now() / 1000) - 25 * 3600;
    meta.setState(STATE_LAST_FULL_SCAN, String(oldTime));
    meta.save();

    const api = { listRecent: () => Promise.resolve([] as Record<string, unknown>[]) };
    const result = await tryCachedCloudScan({
      api,
      meta,
      skipDesktopSeed: true,
      cacheTtlSeconds: 0,
    });

    expect(result).toBeNull();
  });

  it('returns cached when last full scan was <24h ago', async () => {
    const snap = new Map<RelPath, CloudFile>();
    snap.set(asRelPath('doc.md'), makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);

    const api = { listRecent: () => Promise.resolve([] as Record<string, unknown>[]) };
    const result = await tryCachedCloudScan({
      api,
      meta,
      skipDesktopSeed: true,
      cacheTtlSeconds: 0,
    });

    expect(result).not.toBeNull();
    expect(result!.has(asRelPath('doc.md'))).toBe(true);
  });

  it('saveScanVersion records last_full_scan_time', () => {
    const snap = new Map<RelPath, CloudFile>();
    snap.set(asRelPath('doc.md'), makeCloudFile('f-1', 'doc.note'));

    saveScanVersion(meta, snap, 10);

    const stored = meta.getStateInt(STATE_LAST_FULL_SCAN);
    expect(stored).toBeGreaterThan(0);
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs(stored - now)).toBeLessThan(5);
  });
});

describe('tryCachedCloudScan: empty file_id forces full scan', () => {
  it('returns null when metadata has an empty file_id row', async () => {
    const snap = new Map<RelPath, CloudFile>();
    snap.set(asRelPath('doc.md'), makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);
    meta.setFileInfo(asRelPath('orphan.md'), {
      fileId: asFileId(''),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
    });
    meta.save();

    const api = { listRecent: () => Promise.resolve([] as Record<string, unknown>[]) };
    const result = await tryCachedCloudScan({
      api,
      meta,
      skipDesktopSeed: true,
      cacheTtlSeconds: 0,
    });
    expect(result).toBeNull();
  });
});
