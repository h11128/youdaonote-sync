import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { SyncEngine } from './engine.js';
import { MetadataStore } from './metadata/store.js';
import { asContentHash } from './types/common.js';
import type { FileId } from './types/common.js';
import { makeCloudEntry, buildMockApi, setupE2EContext } from './e2e-fixtures.js';

describe('E2E: uploadedPaths — merge and upload', () => {
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

  it('diff3 merge adds relPath to uploadedPaths', async () => {
    const meta = new MetadataStore(metaPath);
    const baseContent = 'line1\nline2\nline3';
    const localContent = 'line1\nlocal-edit\nline3';
    const cloudContent = 'line1\nline2\ncloud-edit';

    writeFileSync(join(localDir, 'merge.md'), localContent);
    const now = Math.floor(Date.now() / 1000);
    meta.setFileInfo('merge.md', {
      fileId: 'f-merge' as FileId,
      cloudMtime: now - 100,
      localMtime: now - 200,
      contentHash: asContentHash('old-hash'),
      lastSyncAt: now - 300,
    });
    meta.saveBaseContent('merge.md', Buffer.from(baseContent), 'base-hash');
    meta.save();

    const cloudEntries = [makeCloudEntry('f-merge', 'merge.md', now)];
    const cloudFiles = new Map([['f-merge', cloudContent]]);
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

    expect(result.stats.merged).toBe(1);
    expect(result.stats.uploadedPaths.has('merge.md')).toBe(true);
    engine.close();
  });

  it('upload adds relPath to uploadedPaths', async () => {
    const meta = new MetadataStore(metaPath);
    writeFileSync(join(localDir, 'upload-test.md'), '# Upload');
    const mockApi = buildMockApi([], new Map());

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
    expect(result.stats.uploadedPaths.has('upload-test.md')).toBe(true);
    engine.close();
  });
});

describe('E2E: uploadedPaths — push direction', () => {
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

  it('conflict push skips uploadedPaths in push mode', async () => {
    const meta = new MetadataStore(metaPath);
    writeFileSync(join(localDir, 'cpush.md'), 'local version');
    const now = Math.floor(Date.now() / 1000);
    meta.setFileInfo('cpush.md', {
      fileId: 'f-cp' as FileId,
      cloudMtime: now - 100,
      localMtime: now - 200,
      contentHash: asContentHash('old-hash'),
      lastSyncAt: now - 300,
    });
    meta.save();

    const cloudEntries = [makeCloudEntry('f-cp', 'cpush.md', now)];
    const cloudFiles = new Map([['f-cp', 'cloud version']]);
    const mockApi = buildMockApi(cloudEntries, cloudFiles);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
      direction: 'push',
    });

    const result = await engine.sync();

    expect(result.stats.uploadedPaths.has('cpush.md')).toBe(false);
    engine.close();
  });
});

describe('E2E: gc cleans stale metadata in postSyncCleanup', () => {
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

  it('removes metadata for files synced >30d ago with no local file', async () => {
    const meta = new MetadataStore(metaPath);
    const oldTs = Math.floor(Date.now() / 1000) - 40 * 86400;

    meta.setFileInfo('ancient-deleted.md', {
      fileId: 'f-ancient' as FileId,
      cloudMtime: oldTs,
      localMtime: oldTs,
      lastSyncAt: oldTs,
    });
    meta.save();

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

    expect(meta.getFileInfo('ancient-deleted.md')).toBeNull();
    engine.close();
  });

  it('preserves metadata for recently synced files even without local file', async () => {
    const meta = new MetadataStore(metaPath);
    const recentTs = Math.floor(Date.now() / 1000) - 5 * 86400;

    meta.setFileInfo('recent-deleted.md', {
      fileId: 'f-recent' as FileId,
      cloudMtime: recentTs,
      localMtime: recentTs,
      lastSyncAt: recentTs,
    });
    meta.save();

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

    expect(meta.getFileInfo('recent-deleted.md')).not.toBeNull();
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

    expect(result.stats.downloaded).toBe(1);
    expect(existsSync(join(localDir, 'doc.md'))).toBe(true);
    expect(existsSync(join(localDir, 'doc.conflict.20260303_120000.md'))).toBe(false);

    engine.close();
  });
});
