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
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { SyncEngine } from './engine.js';
import { MetadataStore } from './metadata/store.js';
import { asContentHash } from './types/common.js';
import type { FileId } from './types/common.js';
import { computeContentHashFromFile, computeContentHashFromBytes } from './hash.js';
import { makeCloudEntry, buildMockApi, setupE2EContext } from './e2e-fixtures.js';

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
      pushed: [] as { name: string; body: string }[],
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
    expect(recorder.pushed[0]?.name).toBe('new-doc.md');

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
      makeCloudEntry('f-cloud', 'cloud-note.md', Math.floor(Date.now() / 1000), {
        parentId: 'root',
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
    computeContentHashFromFile(join(localDir, 'doc.md'));

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
      pushed: [] as { name: string; body: string }[],
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
      pushed: [] as { name: string; body: string }[],
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

    await engine.sync();

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
      makeCloudEntry('dir-photos', 'photos', 0, { parentId: 'root', dir: true }),
      makeCloudEntry('f-pic', 'pic.md', Math.floor(Date.now() / 1000), {
        parentId: 'dir-photos',
      }),
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
      pushed: [] as { name: string; body: string }[],
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
      pushed: [] as { name: string; body: string }[],
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

    await engine.sync();

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
