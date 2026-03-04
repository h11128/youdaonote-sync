/**
 * End-to-end integration tests for every major sync feature.
 *
 * Uses real MetadataStore (in-memory SQLite) + real local files,
 * mock API to avoid network calls. Each test exercises the full
 * SyncEngine pipeline: lock → heal → scan → calibrate → moves → orphan
 *   → warmup → classify → refine → filter → execute → cleanup → dedup → git.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { SyncEngine } from './engine.js';
import { MetadataStore } from './metadata/store.js';
import type { YoudaoNoteApi } from './api/client.js';
import type { DirInfoByIdResponse } from './types/dir.js';
import { asDirId, asFileId, asContentHash } from './types/common.js';
import type { FileId, ContentHash } from './types/common.js';
import { computeContentHashFromFile, computeContentHashFromBytes } from './hash.js';
import { autoDedup } from './dedup/index.js';
import { discardOrphanDuplicates } from './dedup/orphan.js';
import { gc } from './metadata/health.js';

// ====== Mock helpers ======

function makeCloudEntry(
  id: string,
  name: string,
  mtime: number,
  parentId = 'root',
  opts?: { dir?: boolean; domain?: number },
) {
  return {
    fileEntry: {
      id,
      name,
      parentId,
      dir: opts?.dir ?? false,
      modifyTimeForSort: mtime,
      createTimeForSort: mtime - 1000,
      domain: opts?.domain ?? 1,
    },
  };
}

function buildMockApi(
  cloudEntries: Record<string, unknown>[],
  cloudFiles: Map<string, string>,
  recorder?: {
    pushed: { name: string; body: string }[];
    deleted: string[];
    moved: string[];
    dirs: string[];
  },
): YoudaoNoteApi {
  return {
    loginByCookies: () => null,
    getRootId: () => Promise.resolve(asDirId('root-dir')),
    getDirInfoById: () => Promise.resolve({ entries: cloudEntries } as DirInfoByIdResponse),
    getFileById: (fileId: FileId) => {
      const content = cloudFiles.get(fileId);
      if (!content) throw new Error(`File not found: ${fileId}`);
      return Promise.resolve(new TextEncoder().encode(content).buffer);
    },
    pushFile: (opts: Record<string, unknown>) => {
      recorder?.pushed.push({ name: opts.name as string, body: opts.bodyString as string });
      return Promise.resolve({
        entry: { id: opts.fileId ?? 'new-id', modifyTimeForSort: Math.floor(Date.now() / 1000) },
      });
    },
    createDir: (_parentId: unknown, name: unknown) => {
      recorder?.dirs.push(name as string);
      return Promise.resolve({ fileEntry: { id: `dir-${String(name)}` } });
    },
    deleteFile: (fileId: FileId) => {
      recorder?.deleted.push(fileId);
      return Promise.resolve({});
    },
    moveFile: (fileId: FileId) => {
      recorder?.moved.push(fileId);
      return Promise.resolve({});
    },
    renameFile: () => Promise.resolve({}),
    listRecent: () => Promise.resolve([]),
  } as unknown as YoudaoNoteApi;
}

function setupE2EContext() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const localDir = join(tmpDir, 'notes');
  const metaPath = join(tmpDir, 'meta.db');
  mkdirSync(localDir, { recursive: true });
  return {
    tmpDir,
    localDir,
    metaPath,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('E2E: upload and download', () => {
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

  it('uploads a local-only file and records metadata', async () => {
    const meta = new MetadataStore(metaPath);
    writeFileSync(join(localDir, 'new-doc.md'), '# My New Doc\nHello');

    const recorder = {
      pushed: [] as any[],
      deleted: [] as string[],
      moved: [] as string[],
      dirs: [] as string[],
    };
    const mockApi = buildMockApi([], new Map(), recorder);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });

    const result = await engine.sync();

    expect(result.stats.uploaded).toBe(1);
    expect(recorder.pushed.length).toBe(1);
    expect(recorder.pushed[0].name).toBe('new-doc.md');

    // Metadata should exist after upload
    const record = meta.getFileInfo('new-doc.md');
    expect(record).not.toBeNull();
    expect(record!.lastSyncAt).toBeGreaterThan(0);

    engine.close();
  });

  it('downloads a cloud-only file and saves base for diff3', async () => {
    const meta = new MetadataStore(metaPath);
    const cloudContent = '# Cloud Note';
    const cloudEntries = [
      makeCloudEntry('f-cloud', 'cloud-note.md', Math.floor(Date.now() / 1000), 'root', {
        domain: 0,
      }),
    ];
    const cloudFiles = new Map([['f-cloud', cloudContent]]);
    const mockApi = buildMockApi(cloudEntries, cloudFiles);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });

    const result = await engine.sync();

    expect(result.stats.downloaded).toBe(1);
    expect(readFileSync(join(localDir, 'cloud-note.md'), 'utf-8')).toBe(cloudContent);

    // domain=0 should save base for future diff3
    const base = meta.getBaseContent('cloud-note.md');
    expect(base).not.toBeNull();

    engine.close();
  });
});

describe('E2E: conflict diff3 merge', () => {
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

  it('merges conflict via diff3 when base exists and no conflicts', async () => {
    const meta = new MetadataStore(metaPath);

    const baseContent = 'line1\nline2\nline3';
    const localContent = 'line1\nlocal-changed\nline3';
    const cloudContent = 'line1\nline2\ncloud-added';

    writeFileSync(join(localDir, 'doc.md'), localContent);
    const _localHash = computeContentHashFromFile(join(localDir, 'doc.md'))!;

    const now = Math.floor(Date.now() / 1000);
    meta.setFileInfo('doc.md', {
      fileId: 'f-doc' as FileId,
      cloudMtime: now - 100,
      localMtime: now - 200,
      contentHash: asContentHash('old-hash'),
      lastSyncAt: now - 300,
    });
    meta.saveBaseContent('doc.md', Buffer.from(baseContent), 'base-hash');
    meta.save();

    const cloudEntries = [makeCloudEntry('f-doc', 'doc.md', now)];
    const cloudFiles = new Map([['f-doc', cloudContent]]);
    const recorder = {
      pushed: [] as any[],
      deleted: [] as string[],
      moved: [] as string[],
      dirs: [] as string[],
    };
    const mockApi = buildMockApi(cloudEntries, cloudFiles, recorder);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });

    const result = await engine.sync();

    // Merge should succeed — result is local-changed + cloud-added
    expect(result.stats.merged).toBe(1);
    const merged = readFileSync(join(localDir, 'doc.md'), 'utf-8');
    expect(merged).toContain('local-changed');
    expect(merged).toContain('cloud-added');

    // Merged content should be uploaded
    expect(recorder.pushed.length).toBe(1);

    engine.close();
  });
});

describe('E2E: conflict fallback', () => {
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

  it('backup + download when diff3 fails', async () => {
    const meta = new MetadataStore(metaPath);
    const localContent = 'completely different local version';
    const cloudContent = 'completely different cloud version';
    writeFileSync(join(localDir, 'conflict.md'), localContent);
    const now = Math.floor(Date.now() / 1000);
    meta.setFileInfo('conflict.md', {
      fileId: 'f-c' as FileId,
      cloudMtime: now - 100,
      localMtime: now - 200,
      contentHash: asContentHash('old-hash'),
      lastSyncAt: now - 300,
    });
    const cloudEntries = [makeCloudEntry('f-c', 'conflict.md', now)];
    const cloudFiles = new Map([['f-c', cloudContent]]);
    const mockApi = buildMockApi(cloudEntries, cloudFiles);
    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });
    const result = await engine.sync();
    expect(result.stats.conflicts).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(localDir, 'conflict.md'), 'utf-8')).toBe(cloudContent);
    const files = readdirSync(localDir);
    expect(files.find((f) => f.includes('.conflict.'))).toBeDefined();
    engine.close();
  });
});

describe('E2E: push-mode conflict', () => {
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

  it('skipped (matches Python — avoid overwriting cloud)', async () => {
    const meta = new MetadataStore(metaPath);

    const localContent = 'local push version';
    const cloudContent = 'cloud version';

    writeFileSync(join(localDir, 'push-conflict.md'), localContent);

    const now = Math.floor(Date.now() / 1000);
    meta.setFileInfo('push-conflict.md', {
      fileId: 'f-pc' as FileId,
      cloudMtime: now - 100,
      localMtime: now - 200,
      contentHash: asContentHash('old-hash'),
      lastSyncAt: now - 300,
    });

    const cloudEntries = [makeCloudEntry('f-pc', 'push-conflict.md', now)];
    const cloudFiles = new Map([['f-pc', cloudContent]]);
    const recorder = {
      pushed: [] as any[],
      deleted: [] as string[],
      moved: [] as string[],
      dirs: [] as string[],
    };
    const mockApi = buildMockApi(cloudEntries, cloudFiles, recorder);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
      direction: 'push',
    });

    const _result = await engine.sync();

    // In push mode, conflict items are filtered out (matches Python filter_by_direction)
    // This avoids overwriting cloud changes without user confirmation
    expect(recorder.pushed.length).toBe(0);

    // Local file should still have local content (unchanged)
    expect(readFileSync(join(localDir, 'push-conflict.md'), 'utf-8')).toBe(localContent);

    engine.close();
  });
});

describe('E2E: move and directory', () => {
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

  it('executes cloud move when file_id matches', async () => {
    const meta = new MetadataStore(metaPath);
    const hash = computeContentHashFromBytes(new TextEncoder().encode('moved content'), 'test.md');
    writeFileSync(join(localDir, 'new-location.md'), 'moved content');
    meta.setFileInfo('old-location.md', {
      fileId: 'f-moved' as FileId,
      cloudMtime: 1000,
      localMtime: 1000,
      contentHash: hash,
      lastSyncAt: 1000,
    });
    meta.save();
    const cloudEntries = [makeCloudEntry('f-moved', 'new-location.md', 1000)];
    const mockApi = buildMockApi(cloudEntries, new Map());
    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });
    await engine.sync();
    expect(meta.getFileInfo('new-location.md')).not.toBeNull();
    engine.close();
  });

  it('creates local directory for cloud-only dir', async () => {
    const meta = new MetadataStore(metaPath);
    const cloudEntries = [
      makeCloudEntry('dir-photos', 'photos', 0, 'root', { dir: true }),
      makeCloudEntry('f-pic', 'pic.md', Math.floor(Date.now() / 1000), 'dir-photos'),
    ];
    const cloudFiles = new Map([['f-pic', '# Photo note']]);
    const mockApi = buildMockApi(cloudEntries, cloudFiles);
    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });
    const result = await engine.sync();
    expect(result.stats.downloaded).toBeGreaterThanOrEqual(1);
    engine.close();
  });
});

describe('E2E: direction filter', () => {
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

  it('pull direction: downloads but skips uploads', async () => {
    const meta = new MetadataStore(metaPath);

    writeFileSync(join(localDir, 'local-only.md'), 'should not upload');

    const cloudContent = '# From Cloud';
    const cloudEntries = [makeCloudEntry('f-pull', 'cloud-only.md', Math.floor(Date.now() / 1000))];
    const cloudFiles = new Map([['f-pull', cloudContent]]);
    const recorder = {
      pushed: [] as any[],
      deleted: [] as string[],
      moved: [] as string[],
      dirs: [] as string[],
    };
    const mockApi = buildMockApi(cloudEntries, cloudFiles, recorder);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
      direction: 'pull',
    });

    const result = await engine.sync();

    expect(result.stats.downloaded).toBe(1);
    expect(recorder.pushed.length).toBe(0);
    expect(readFileSync(join(localDir, 'cloud-only.md'), 'utf-8')).toBe(cloudContent);

    engine.close();
  });

  it('push direction: uploads but skips downloads', async () => {
    const meta = new MetadataStore(metaPath);

    writeFileSync(join(localDir, 'local-new.md'), '# Upload Me');

    const cloudEntries = [makeCloudEntry('f-cloud', 'cloud-new.md', Math.floor(Date.now() / 1000))];
    const cloudFiles = new Map([['f-cloud', 'not downloaded']]);
    const recorder = {
      pushed: [] as any[],
      deleted: [] as string[],
      moved: [] as string[],
      dirs: [] as string[],
    };
    const mockApi = buildMockApi(cloudEntries, cloudFiles, recorder);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
      direction: 'push',
    });

    const _result = await engine.sync();

    expect(recorder.pushed.length).toBe(1);
    expect(existsSync(join(localDir, 'cloud-new.md'))).toBe(false);

    engine.close();
  });
});

describe('E2E: stale metadata cleanup', () => {
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

  it('cleans up stale metadata after full scan', async () => {
    const meta = new MetadataStore(metaPath);

    // Metadata has a file that no longer exists in cloud
    meta.setFileInfo('deleted-from-cloud.md', {
      fileId: 'f-stale' as FileId,
      cloudMtime: 1000,
      localMtime: 1000,
      lastSyncAt: 1000,
    });
    writeFileSync(join(localDir, 'deleted-from-cloud.md'), 'still local');
    meta.save();

    // Cloud is empty → full scan
    const mockApi = buildMockApi([], new Map());

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });

    await engine.sync();

    // file_id should be cleared (stale cleanup)
    const record = meta.getFileInfo('deleted-from-cloud.md');
    if (record) {
      expect(record.fileId).toBeFalsy();
    }

    engine.close();
  });
});

describe('E2E: .conflict. filter', () => {
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

  it('filters .conflict. files from cloud snapshot', async () => {
    const meta = new MetadataStore(metaPath);

    const cloudEntries = [
      makeCloudEntry('f-normal', 'doc.md', Math.floor(Date.now() / 1000)),
      makeCloudEntry(
        'f-conflict',
        'doc.conflict.20260303_120000.md',
        Math.floor(Date.now() / 1000),
      ),
    ];
    const cloudFiles = new Map([
      ['f-normal', '# Normal'],
      ['f-conflict', '# Conflict backup'],
    ]);
    const mockApi = buildMockApi(cloudEntries, cloudFiles);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });

    const result = await engine.sync();

    // Only the normal file should be downloaded, not the conflict backup
    expect(result.stats.downloaded).toBe(1);
    expect(existsSync(join(localDir, 'doc.md'))).toBe(true);
    expect(existsSync(join(localDir, 'doc.conflict.20260303_120000.md'))).toBe(false);

    engine.close();
  });
});

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
    meta.setFileInfo('existing-cloud.md', {
      fileId: 'f-existing' as FileId,
      cloudMtime: 1000,
      localMtime: 1000,
      contentHash: hash,
      lastSyncAt: 1000,
    });
    meta.save();

    const recorder = {
      pushed: [] as any[],
      deleted: [] as string[],
      moved: [] as string[],
      dirs: [] as string[],
    };
    const mockApi = buildMockApi([], new Map(), recorder);

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
    const cloudSnap = new Map([['dir1/doc.md', { isDir: false }]]);
    const localSnap = new Map([
      ['dir1/doc.md', { isDir: false, path: '/notes/dir1/doc.md' }],
      ['dir2/doc.md', { isDir: false, path: '/notes/dir2/doc.md' }],
      ['unique.md', { isDir: false, path: '/notes/unique.md' }],
    ]);
    const localHashes = new Map<string, ContentHash | null>([
      ['dir1/doc.md', hash1],
      ['dir2/doc.md', hash1], // same hash + same basename as both-side file → orphan
      ['unique.md', hash2], // different hash → not orphan
    ]);

    const skipped = discardOrphanDuplicates(cloudSnap, localSnap, localHashes);

    expect(skipped.has('dir2/doc.md')).toBe(true);
    expect(skipped.has('unique.md')).toBe(false);
    expect(skipped.has('dir1/doc.md')).toBe(false);
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

    meta.setFileInfo('images/photo.png', {
      fileId: asFileId('f1'),
      cloudMtime: 1,
      localMtime: 1,
      contentHash: hash,
    });
    meta.setFileInfo('backup/photo.png', {
      fileId: asFileId('f2'),
      cloudMtime: 1,
      localMtime: 1,
      contentHash: hash,
    });

    const mockApi = { deleteFile: () => Promise.resolve({}) };
    const { stats } = await autoDedup(root, meta, { api: mockApi as any });

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

    meta.setFileInfo('a.png', {
      fileId: asFileId('f1'),
      cloudMtime: 1,
      localMtime: 1,
      contentHash: hash,
    });
    meta.setFileInfo('b.png', {
      fileId: asFileId('f2'),
      cloudMtime: 1,
      localMtime: 1,
      contentHash: hash,
    });

    const mockApi = { deleteFile: () => Promise.resolve({}) };
    const { stats } = await autoDedup(root, meta, { api: mockApi as any });

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
    meta.setFileRefs('deleted-doc.md', ['images/a.png', 'images/b.png']);

    // existing.md still exists
    writeFileSync(join(localDir, 'existing.md'), 'hello');
    meta.setFileRefs('existing.md', ['images/c.png']);

    const stats = gc(meta, localDir);

    expect(stats.refs).toBe(1);
    expect(meta.getFileRefs('deleted-doc.md')).toEqual([]);
    expect(meta.getFileRefs('existing.md')).toEqual(['images/c.png']);
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
    meta.setFileInfo('cached.md', {
      fileId: 'f-cached' as FileId,
      cloudMtime: cloudMtime - 100,
      localMtime: fileMtime,
      contentHash: localHash,
      cloudContentHash: localHash,
      lastSyncAt: fileMtime - 50,
    });
    meta.save();

    let _apiCallCount = 0;
    const cloudEntries = [makeCloudEntry('f-cached', 'cached.md', cloudMtime)];
    const mockApi = {
      loginByCookies: () => null,
      getRootId: () => Promise.resolve(asDirId('root-dir')),
      getDirInfoById: () => Promise.resolve({ entries: cloudEntries } as DirInfoByIdResponse),
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
    const state = result.classified.get('cached.md');
    expect(state).toBeDefined();
    const skipKinds = ['synced', 'cloudModifiedMtimeOnly', 'bothModifiedConverged'];
    expect(skipKinds).toContain(state!.kind);

    engine.close();
  });
});
