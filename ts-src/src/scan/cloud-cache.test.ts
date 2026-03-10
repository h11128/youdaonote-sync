import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../metadata/store.js';
import { asEpochSeconds } from '../types/common.js';
import type { DirId, FileId } from '../types/common.js';
import { tryCachedCloudScan, loadCloudFilesFromCache, saveScanVersion } from './cloud-cache.js';
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
    const result = await tryCachedCloudScan({ api, meta, skipDesktopSeed: true });
    expect(result).toBeNull();
  });

  it('returns cached data when cloud has no changes', async () => {
    const snap = new Map<string, CloudFile>();
    snap.set('doc.md', makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);

    const api = { listRecent: () => Promise.resolve([] as Record<string, unknown>[]) };
    const result = await tryCachedCloudScan({ api, meta, skipDesktopSeed: true });
    expect(result).not.toBeNull();
    expect(result!.has('doc.md')).toBe(true);
  });

  it('returns cached data when cloud version matches', async () => {
    const snap = new Map<string, CloudFile>();
    snap.set('doc.md', makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);

    const api = {
      listRecent: () => Promise.resolve([makeEntry('f-1', 'doc.note', 10)]),
    };
    const result = await tryCachedCloudScan({ api, meta, skipDesktopSeed: true });
    expect(result).not.toBeNull();
    expect(result!.has('doc.md')).toBe(true);
  });

  it('updates existing file when cloud version increases', async () => {
    const snap = new Map<string, CloudFile>();
    snap.set('doc.md', makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);

    const api = {
      listRecent: () =>
        Promise.resolve([
          makeEntry('f-1', 'doc.note', 10),
          makeEntry('f-1', 'doc.note', 15, { mtime: 2000 }),
        ]),
    };
    const result = await tryCachedCloudScan({ api, meta, skipDesktopSeed: true });
    expect(result).not.toBeNull();
    expect(result!.get('doc.md')!.mtime).toBe(2000);
  });
});

describe('tryCachedCloudScan: incremental new entries', () => {
  it('adds new file via parentId resolution', async () => {
    meta.setDirInfo('', 'root' as DirId, null);
    meta.setDirInfo('notes', 'dir-notes' as DirId, 'root' as DirId);

    const snap = new Map<string, CloudFile>();
    snap.set('notes/old.md', makeCloudFile('f-1', 'old.note', 'dir-notes'));
    saveScanVersion(meta, snap, 10);

    const api = {
      listRecent: () =>
        Promise.resolve([
          makeEntry('f-1', 'old.note', 10, { parentId: 'dir-notes' }),
          makeEntry('f-new', 'brand-new.note', 15, { parentId: 'dir-notes' }),
        ]),
    };
    const result = await tryCachedCloudScan({ api, meta, skipDesktopSeed: true });
    expect(result).not.toBeNull();
    expect(result!.has('notes/brand-new.md')).toBe(true);
    expect(result!.get('notes/brand-new.md')!.id).toBe('f-new');
  });

  it('adds new directory via parentId resolution', async () => {
    meta.setDirInfo('', 'root' as DirId, null);

    const snap = new Map<string, CloudFile>();
    snap.set('existing.md', makeCloudFile('f-1', 'existing.note'));
    saveScanVersion(meta, snap, 10);

    const api = {
      listRecent: () =>
        Promise.resolve([
          makeEntry('f-1', 'existing.note', 10, { parentId: 'root' }),
          makeEntry('dir-photos', 'photos', 15, { parentId: 'root', dir: true }),
        ]),
    };
    const result = await tryCachedCloudScan({ api, meta, skipDesktopSeed: true });
    expect(result).not.toBeNull();
    expect(result!.has('photos')).toBe(true);
    expect(result!.get('photos')!.isDir).toBe(true);
  });

  it('skips new file when parentId cannot be resolved', async () => {
    const snap = new Map<string, CloudFile>();
    snap.set('doc.md', makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);

    const api = {
      listRecent: () =>
        Promise.resolve([
          makeEntry('f-1', 'doc.note', 10),
          makeEntry('f-orphan', 'orphan.note', 15, { parentId: 'unknown-dir' }),
        ]),
    };
    const result = await tryCachedCloudScan({ api, meta, skipDesktopSeed: true });
    expect(result).not.toBeNull();
    expect(result!.has('doc.md')).toBe(true);
    expect([...result!.keys()].some((k) => k.includes('orphan'))).toBe(false);
  });
});

describe('tryCachedCloudScan: error handling and overflow', () => {
  it('returns null when all recent entries are newer (overflow)', async () => {
    const snap = new Map<string, CloudFile>();
    snap.set('doc.md', makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 5);

    const entries = Array.from({ length: 30 }, (_, i) =>
      makeEntry(`f-${i}`, `file${i}.note`, 10 + i),
    );
    const api = { listRecent: () => Promise.resolve(entries) };
    const result = await tryCachedCloudScan({ api, meta, skipDesktopSeed: true });
    expect(result).toBeNull();
  });

  it('falls back to cached data on API error', async () => {
    const snap = new Map<string, CloudFile>();
    snap.set('doc.md', makeCloudFile('f-1', 'doc.note'));
    saveScanVersion(meta, snap, 10);

    const api = {
      listRecent: () => Promise.reject(new Error('network')),
    };
    const result = await tryCachedCloudScan({ api, meta, skipDesktopSeed: true });
    expect(result).not.toBeNull();
    expect(result!.has('doc.md')).toBe(true);
  });
});

describe('loadCloudFilesFromCache', () => {
  it('returns null when no files cached', () => {
    expect(loadCloudFilesFromCache(meta)).toBeNull();
  });

  it('skips .conflict. files', () => {
    meta.cacheCloudFileInfo('doc.md', {
      fileId: 'f-1' as FileId,
      cloudMtime: asEpochSeconds(100),
      parentId: 'root' as DirId,
      domain: 0,
      createTime: asEpochSeconds(50),
    });
    meta.cacheCloudFileInfo('doc.conflict.md', {
      fileId: 'f-2' as FileId,
      cloudMtime: asEpochSeconds(200),
      parentId: 'root' as DirId,
      domain: 0,
      createTime: asEpochSeconds(50),
    });
    const result = loadCloudFilesFromCache(meta);
    expect(result).not.toBeNull();
    expect(result!.has('doc.md')).toBe(true);
    expect(result!.has('doc.conflict.md')).toBe(false);
  });
});
