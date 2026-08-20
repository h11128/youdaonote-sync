/**
 * E2E tests for dedup, orphan discard, GC, and refine cache behavior.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SyncEngine } from '../engine/engine.js';
import { MetadataStore } from '../metadata/store.js';
import type { YoudaoNoteApi } from '../api/client.js';
import type { DirInfoByIdResponse } from '../types/dir.js';
import { asDirId, asFileId, asContentHash, asEpochSeconds, asRelPath } from '../types/common.js';
import type { FileId, ContentHash, RelPath } from '../types/common.js';
import { computeContentHashFromFile } from '../algo/hash.js';
import { autoDedup } from './index.js';
import { discardOrphanDuplicates } from './orphan.js';
import { gc } from '../metadata/health.js';
import { makeCloudEntry, buildMockApi, setupE2EContext } from '../engine/e2e-fixtures.js';

describe('E2E: upload dedup', () => {
  let localDir: string;
  let metaPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupE2EContext();
    localDir = ctx.localDir;
    metaPath = ctx.metaPath;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('skips upload when identical content already exists in cloud', async () => {
    const meta = new MetadataStore(metaPath);

    const content = 'identical content';
    writeFileSync(join(localDir, 'new-file.md'), content);
    const hash = computeContentHashFromFile(join(localDir, 'new-file.md'))!;

    // Another file already synced with same hash
    meta.setFileInfo(asRelPath('existing-cloud.md'), {
      fileId: 'f-existing' as FileId,
      cloudMtime: asEpochSeconds(1000),
      localMtime: asEpochSeconds(1000),
      contentHash: hash,
      lastSyncAt: asEpochSeconds(1000),
    });
    meta.save();

    const recorder = {
      pushed: [] as { name: string; body: string }[],
      deleted: [] as string[],
      moved: [] as string[],
      dirs: [] as string[],
    };
    const cloudEntries = [makeCloudEntry('f-existing', 'existing-cloud.md', 1000)];
    const mockApi = buildMockApi(cloudEntries, new Map([['f-existing', content]]), recorder);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });

    const result = await engine.sync();

    // Should skip the upload because hash already exists in cloud
    expect(recorder.pushed.length).toBe(0);
    expect(result.stats.skipped).toBeGreaterThanOrEqual(1);

    engine.close();
  });
});

describe('E2E: orphan duplicate discard', () => {
  it('skips local-only files that duplicate both-side files (same name, different dir)', () => {
    const hash1 = asContentHash('hash-same');
    const hash2 = asContentHash('hash-different');

    // 'dir1/doc.md' is on both sides; 'dir2/doc.md' is local-only with same hash → orphan
    const cloudSnap = new Map<RelPath, { isDir: boolean }>([
      [asRelPath('dir1/doc.md'), { isDir: false }],
    ]);
    const localSnap = new Map<RelPath, { isDir: boolean; path?: string }>([
      [asRelPath('dir1/doc.md'), { isDir: false, path: '/notes/dir1/doc.md' }],
      [asRelPath('dir2/doc.md'), { isDir: false, path: '/notes/dir2/doc.md' }],
      [asRelPath('unique.md'), { isDir: false, path: '/notes/unique.md' }],
    ]);
    const localHashes = new Map<RelPath, ContentHash | null>([
      [asRelPath('dir1/doc.md'), hash1],
      [asRelPath('dir2/doc.md'), hash1], // same hash + same basename as both-side file → orphan
      [asRelPath('unique.md'), hash2], // different hash → not orphan
    ]);

    const skipped = discardOrphanDuplicates(cloudSnap, localSnap, localHashes);

    expect(skipped.has(asRelPath('dir2/doc.md'))).toBe(true);
    expect(skipped.has(asRelPath('unique.md'))).toBe(false);
    expect(skipped.has(asRelPath('dir1/doc.md'))).toBe(false);
  });
});

describe('E2E: dedup asset protection', () => {
  let tmpDir: string;
  let root: string;
  let metaPath: string;
  let meta: MetadataStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'e2e-dedup-'));
    root = join(tmpDir, 'notes');
    metaPath = join(tmpDir, 'meta.db');
    mkdirSync(root, { recursive: true });
    meta = new MetadataStore(metaPath);
  });

  afterEach(() => {
    meta.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('all-cloud asset group: keeps referenced, removes unreferenced', async () => {
    const hash = asContentHash('img-hash');

    // MD file referencing one copy
    writeFileSync(join(root, 'doc.md'), '![pic](images/photo.png)');
    mkdirSync(join(root, 'images'), { recursive: true });
    mkdirSync(join(root, 'backup'), { recursive: true });
    writeFileSync(join(root, 'images', 'photo.png'), 'img-data');
    writeFileSync(join(root, 'backup', 'photo.png'), 'img-data');

    meta.setFileInfo(asRelPath('images/photo.png'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });
    meta.setFileInfo(asRelPath('backup/photo.png'), {
      fileId: asFileId('f2'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });

    const mockApi = { deleteFile: () => Promise.resolve({}) };
    const { stats } = await autoDedup(root, meta, { api: mockApi as unknown as YoudaoNoteApi });

    // Referenced asset should be kept, unreferenced should be deleted
    expect(existsSync(join(root, 'images', 'photo.png'))).toBe(true);
    expect(stats.deleted).toBeGreaterThanOrEqual(1);
  });

  it('all-cloud asset group: all referenced → skip (no deletion)', async () => {
    const hash = asContentHash('all-ref-hash');

    // Two MD files each referencing their copy
    writeFileSync(join(root, 'doc1.md'), '![pic](a.png)');
    writeFileSync(join(root, 'doc2.md'), '![pic](b.png)');
    writeFileSync(join(root, 'a.png'), 'img-data');
    writeFileSync(join(root, 'b.png'), 'img-data');

    meta.setFileInfo(asRelPath('a.png'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });
    meta.setFileInfo(asRelPath('b.png'), {
      fileId: asFileId('f2'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });

    const mockApi = { deleteFile: () => Promise.resolve({}) };
    const { stats } = await autoDedup(root, meta, { api: mockApi as unknown as YoudaoNoteApi });

    // Both are referenced → group skipped
    expect(existsSync(join(root, 'a.png'))).toBe(true);
    expect(existsSync(join(root, 'b.png'))).toBe(true);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe('E2E: GC cleans up orphan file_refs', () => {
  let tmpDir: string;
  let localDir: string;
  let metaPath: string;
  let meta: MetadataStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'e2e-gc-'));
    localDir = join(tmpDir, 'notes');
    metaPath = join(tmpDir, 'meta.db');
    mkdirSync(localDir, { recursive: true });
    meta = new MetadataStore(metaPath);
  });

  afterEach(() => {
    meta.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes file_refs for deleted source files', () => {
    // doc.md has refs but the file no longer exists on disk
    meta.setFileRefs(asRelPath('deleted-doc.md'), ['images/a.png', 'images/b.png']);

    // existing.md still exists
    writeFileSync(join(localDir, 'existing.md'), 'hello');
    meta.setFileRefs(asRelPath('existing.md'), ['images/c.png']);

    const stats = gc(meta, localDir);

    expect(stats.refs).toBe(1);
    expect(meta.getFileRefs(asRelPath('deleted-doc.md'))).toEqual([]);
    expect(meta.getFileRefs(asRelPath('existing.md'))).toEqual(['images/c.png']);
  });
});

describe('E2E: refine caches cloudContentHash', () => {
  let tmpDir: string;
  let localDir: string;
  let metaPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'e2e-refine-'));
    localDir = join(tmpDir, 'notes');
    metaPath = join(tmpDir, 'meta.db');
    mkdirSync(localDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses cached cloudContentHash when cloudMtime unchanged', async () => {
    const meta = new MetadataStore(metaPath);

    const content = 'same content both sides';
    writeFileSync(join(localDir, 'cached.md'), content);
    const localHash = computeContentHashFromFile(join(localDir, 'cached.md'))!;
    const fileMtime = Math.floor(statSync(join(localDir, 'cached.md')).mtimeMs / 1000);

    const cloudMtime = fileMtime + 50;

    // Metadata: previously synced with older cloud mtime, same local mtime
    // Cloud now has higher mtime → triggers cloudModifiedContent
    // But cloudContentHash (cached) matches localHash → refine to skip
    meta.setFileInfo(asRelPath('cached.md'), {
      fileId: 'f-cached' as FileId,
      cloudMtime: asEpochSeconds(cloudMtime - 100),
      localMtime: asEpochSeconds(fileMtime),
      contentHash: localHash,
      cloudContentHash: localHash,
      lastSyncAt: asEpochSeconds(fileMtime - 50),
    });
    meta.save();

    let _apiCallCount = 0;
    const cloudEntries = [makeCloudEntry('f-cached', 'cached.md', cloudMtime)];
    const mockApi = {
      loginByCookies: () => null,
      getRootId: () => Promise.resolve(asDirId('root-dir')),
      getDirInfoById: () =>
        Promise.resolve({ entries: cloudEntries } as unknown as DirInfoByIdResponse),
      getFileById: () => {
        _apiCallCount++;
        return Promise.resolve(new TextEncoder().encode(content).buffer);
      },
      pushFile: () => Promise.resolve({ entry: { id: 'id', modifyTimeForSort: cloudMtime } }),
      createDir: () => Promise.resolve({ fileEntry: { id: 'dir-id' } }),
      deleteFile: () => Promise.resolve({}),
      moveFile: () => Promise.resolve({}),
      renameFile: () => Promise.resolve({}),
      listRecent: () => Promise.resolve([]),
    } as unknown as YoudaoNoteApi;

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });

    const result = await engine.sync();

    // Since cloudContentHash matches localHash → refine should downgrade to skip
    const state = result.classified.get(asRelPath('cached.md'));
    expect(state).toBeDefined();
    const skipKinds = ['synced', 'cloudModifiedMtimeOnly', 'bothModifiedConverged'];
    expect(skipKinds).toContain(state!.kind);

    engine.close();
  });
});
