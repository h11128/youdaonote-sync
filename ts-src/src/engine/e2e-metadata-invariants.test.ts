/**
 * SyncEngine e2e coverage for metadata lifecycle invariants (#610/#613).
 * Real MetadataStore + local files + mock API; full engine.sync() pipeline.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { SyncEngine } from './engine.js';
import { MetadataStore } from '../metadata/store.js';
import { asContentHash, asEpochSeconds, asRelPath } from '../types/common.js';
import type { FileId } from '../types/common.js';
import {
  makeCloudEntry,
  buildMockApi,
  setupE2EContext,
  type MockApiRecorder,
} from './e2e-fixtures.js';

function useE2ECtx(): {
  localDir: string;
  metaPath: string;
} {
  let localDir = '';
  let metaPath = '';
  let cleanup = (): void => undefined;
  beforeEach(() => {
    const ctx = setupE2EContext();
    localDir = ctx.localDir;
    metaPath = ctx.metaPath;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });
  return {
    get localDir() {
      return localDir;
    },
    get metaPath() {
      return metaPath;
    },
  };
}

describe('E2E metadata: directory and upload linkage', () => {
  const ctx = useE2ECtx();

  it('directory download does not insert empty file_id into files table', async () => {
    const meta = new MetadataStore(ctx.metaPath);
    const cloudEntries = [
      makeCloudEntry('dir-photos', 'photos', 0, { parentId: 'root', dir: true }),
      makeCloudEntry('f-pic', 'pic.md', Math.floor(Date.now() / 1000), {
        parentId: 'dir-photos',
      }),
    ];
    const mockApi = buildMockApi(cloudEntries, new Map([['f-pic', '# Photo']]));
    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: ctx.metaPath,
      localDir: ctx.localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });
    await engine.sync();
    expect(existsSync(join(ctx.localDir, 'photos'))).toBe(true);
    expect(meta.getDirId(asRelPath('photos'))).toBeTruthy();
    expect(meta.getFileInfo(asRelPath('photos'))).toBeNull();
    expect(meta.getFileInfo(asRelPath('photos/pic.md'))?.fileId).toBe('f-pic');
    engine.close();
  });

  it('keeps file_id after upload when next full scan omits the new cloud path', async () => {
    const meta = new MetadataStore(ctx.metaPath);
    writeFileSync(join(ctx.localDir, 'just-uploaded.md'), '# uploaded');
    const seed = [makeCloudEntry('f-keep', 'keep.md', 1000)];
    const recorder: MockApiRecorder = { pushed: [], deleted: [], moved: [], dirs: [] };
    const mockApi = buildMockApi(seed, new Map([['f-keep', 'seed']]), recorder);
    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: ctx.metaPath,
      localDir: ctx.localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });
    const first = await engine.sync();
    expect(first.stats.uploaded).toBe(1);
    const uploadedId = meta.getFileInfo(asRelPath('just-uploaded.md'))?.fileId;
    expect(uploadedId).toBeTruthy();
    writeFileSync(join(ctx.localDir, 'keep.md'), 'seed');
    const second = await engine.sync();
    expect(second.status).toBe('ok');
    expect(meta.getFileInfo(asRelPath('just-uploaded.md'))?.fileId).toBe(uploadedId);
    engine.close();
  });

  it('fails upload when API returns empty file id and does not mark synced', async () => {
    const meta = new MetadataStore(ctx.metaPath);
    writeFileSync(join(ctx.localDir, 'bad-id.md'), '# bad');
    const mockApi = buildMockApi([], new Map());
    mockApi.pushFile = () =>
      Promise.resolve({
        entry: { id: '', modifyTimeForSort: Math.floor(Date.now() / 1000) },
      });
    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: ctx.metaPath,
      localDir: ctx.localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });
    const result = await engine.sync();
    expect(result.stats.errors).toBeGreaterThanOrEqual(1);
    expect(result.stats.uploaded).toBe(0);
    const rec = meta.getFileInfo(asRelPath('bad-id.md'));
    expect(rec?.lastSyncAt ?? 0).toBe(0);
    expect(rec?.fileId ?? '').toBe('');
    engine.close();
  });
});

describe('E2E metadata: delete record-then-remove', () => {
  const ctx = useE2ECtx();

  it('deleteCloud leaves sync_log but no files row', async () => {
    const meta = new MetadataStore(ctx.metaPath);
    const now = Math.floor(Date.now() / 1000);
    meta.setFileInfo(asRelPath('gone-local.md'), {
      fileId: 'f-gone' as FileId,
      cloudMtime: asEpochSeconds(now - 100),
      localMtime: asEpochSeconds(now - 100),
      contentHash: asContentHash('hash-gone'),
      lastSyncAt: asEpochSeconds(now - 50),
    });
    meta.save();
    const recorder: MockApiRecorder = { pushed: [], deleted: [], moved: [], dirs: [] };
    const mockApi = buildMockApi(
      [makeCloudEntry('f-gone', 'gone-local.md', now - 100)],
      new Map([['f-gone', 'old']]),
      recorder,
    );
    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: ctx.metaPath,
      localDir: ctx.localDir,
      api: mockApi,
      meta,
      autoGit: false,
      propagateDeletes: true,
    });
    const result = await engine.sync();
    expect(result.stats.deletedCloud).toBe(1);
    expect(recorder.deleted).toContain('f-gone');
    expect(meta.getFileInfo(asRelPath('gone-local.md'))).toBeNull();
    expect(
      meta.getSyncLog({ path: asRelPath('gone-local.md') }).some((l) => l.action === 'deleteCloud'),
    ).toBe(true);
    engine.close();
  });

  it('deleteLocal trashes file, logs action, and removes files row', async () => {
    const meta = new MetadataStore(ctx.metaPath);
    const filePath = join(ctx.localDir, 'cloud-gone.md');
    writeFileSync(filePath, 'will be trashed');
    const fileMtime = asEpochSeconds(Math.floor(Date.now() / 1000));
    meta.setFileInfo(asRelPath('cloud-gone.md'), {
      fileId: 'f-cg' as FileId,
      cloudMtime: fileMtime,
      localMtime: fileMtime,
      contentHash: asContentHash('hash-cg'),
      lastSyncAt: fileMtime,
    });
    meta.save();
    const mockApi = buildMockApi([], new Map());
    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: ctx.metaPath,
      localDir: ctx.localDir,
      api: mockApi,
      meta,
      autoGit: false,
      propagateDeletes: true,
    });
    const result = await engine.sync();
    expect(result.stats.deletedLocal).toBe(1);
    expect(existsSync(filePath)).toBe(false);
    expect(meta.getFileInfo(asRelPath('cloud-gone.md'))).toBeNull();
    expect(
      meta.getSyncLog({ path: asRelPath('cloud-gone.md') }).some((l) => l.action === 'deleteLocal'),
    ).toBe(true);
    engine.close();
  });
});

describe('E2E metadata: calibrate and exclude', () => {
  const ctx = useE2ECtx();

  it('calibrate re-links empty file_id when both sides present during sync', async () => {
    const meta = new MetadataStore(ctx.metaPath);
    const content = '# both sides';
    writeFileSync(join(ctx.localDir, 'relink.md'), content);
    meta.setFileInfo(asRelPath('relink.md'), {
      fileId: '' as FileId,
      cloudMtime: asEpochSeconds(50),
      localMtime: asEpochSeconds(50),
      contentHash: asContentHash('stale'),
      lastSyncAt: asEpochSeconds(50),
    });
    meta.save();
    const mockApi = buildMockApi(
      [makeCloudEntry('cf-relink', 'relink.md', Math.floor(Date.now() / 1000))],
      new Map([['cf-relink', content]]),
    );
    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: ctx.metaPath,
      localDir: ctx.localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });
    await engine.sync();
    expect(meta.getFileInfo(asRelPath('relink.md'))?.fileId).toBe('cf-relink');
    engine.close();
  });

  it('exclude pattern is not written into metadata on full scan', async () => {
    const meta = new MetadataStore(ctx.metaPath);
    mkdirSync(join(ctx.localDir, 'data'), { recursive: true });
    writeFileSync(join(ctx.localDir, 'ok.md'), '# ok');
    writeFileSync(join(ctx.localDir, 'data', 'skip.db'), 'bin');
    const mockApi = buildMockApi(
      [makeCloudEntry('f-ok', 'ok.md', 1000), makeCloudEntry('f-db', 'skip.db', 1000)],
      new Map([
        ['f-ok', '# ok'],
        ['f-db', 'bin'],
      ]),
    );
    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: ctx.metaPath,
      localDir: ctx.localDir,
      api: mockApi,
      meta,
      autoGit: false,
      syncExclude: ['*.db', 'data/**'],
    });
    await engine.sync();
    expect(meta.getFileInfo(asRelPath('ok.md'))?.fileId).toBe('f-ok');
    expect(meta.getFileInfo(asRelPath('skip.db'))).toBeNull();
    expect(meta.getFileInfo(asRelPath('data/skip.db'))).toBeNull();
    engine.close();
  });
});
