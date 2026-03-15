import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleMove, fallbackDeleteOldFiles } from './move-handler.js';
import { emptyStats } from './executor.js';
import { MetadataStore } from '../metadata/store.js';
import { asDirId, asEpochSeconds, asFileId, asRelPath, NoteDomain } from '../types/common.js';
import type { FileId } from '../types/common.js';
import type { YoudaoNoteApi } from '../api/client.js';

function makeMockApi(): YoudaoNoteApi {
  return {
    moveFile: vi.fn().mockResolvedValue({}),
    renameFile: vi.fn().mockResolvedValue({}),
    createDir: vi.fn().mockResolvedValue({ fileEntry: { id: 'dir-1' } }),
  } as unknown as YoudaoNoteApi;
}

function setupMoveContext() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'move-test-'));
  const localDir = join(tmpDir, 'notes');
  mkdirSync(localDir, { recursive: true });
  const meta = new MetadataStore(join(tmpDir, 'meta.db'));
  return { tmpDir, localDir, meta };
}

describe('handleMove: local file operations', () => {
  let tmpDir: string;
  let localDir: string;
  let meta: MetadataStore;

  beforeEach(() => {
    ({ tmpDir, localDir, meta } = setupMoveContext());
  });
  afterEach(() => {
    meta.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('moves local file from old path to new path after cloud move', async () => {
    const oldContent = 'file content here';
    writeFileSync(join(localDir, 'old-name.md'), oldContent);
    meta.setFileInfo(asRelPath('old-name.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1000),
      localMtime: asEpochSeconds(1000),
    });

    const stats = emptyStats();
    await handleMove({
      relPath: asRelPath('new-name.md'),
      state: { kind: 'moved', oldPath: asRelPath('old-name.md') },
      ctx: { api: makeMockApi(), meta, rootDirId: asDirId('root'), localDir },
      stats,
    });

    expect(existsSync(join(localDir, 'old-name.md'))).toBe(false);
    expect(existsSync(join(localDir, 'new-name.md'))).toBe(true);
    expect(readFileSync(join(localDir, 'new-name.md'), 'utf-8')).toBe(oldContent);
  });

  it('creates parent directories when moving to a subdirectory', async () => {
    writeFileSync(join(localDir, 'note.md'), 'content');
    meta.setFileInfo(asRelPath('note.md'), {
      fileId: asFileId('f2'),
      cloudMtime: asEpochSeconds(1000),
      localMtime: asEpochSeconds(1000),
    });

    const stats = emptyStats();
    await handleMove({
      relPath: asRelPath('subdir/deep/note.md'),
      state: { kind: 'moved', oldPath: asRelPath('note.md') },
      ctx: { api: makeMockApi(), meta, rootDirId: asDirId('root'), localDir },
      stats,
    });

    expect(existsSync(join(localDir, 'subdir', 'deep', 'note.md'))).toBe(true);
    expect(existsSync(join(localDir, 'note.md'))).toBe(false);
  });

  it('records moved path in changedPaths for git commit', async () => {
    writeFileSync(join(localDir, 'a.md'), 'data');
    meta.setFileInfo(asRelPath('a.md'), {
      fileId: asFileId('f3'),
      cloudMtime: asEpochSeconds(1000),
      localMtime: asEpochSeconds(1000),
    });

    const stats = emptyStats();
    await handleMove({
      relPath: asRelPath('b.md'),
      state: { kind: 'moved', oldPath: asRelPath('a.md') },
      ctx: { api: makeMockApi(), meta, rootDirId: asDirId('root'), localDir },
      stats,
    });

    expect(stats.moved).toBe(1);
    expect(stats.changedPaths).toContain(join(localDir, 'b.md'));
  });
});

describe('handleMove: error handling and metadata', () => {
  let tmpDir: string;
  let localDir: string;
  let meta: MetadataStore;

  beforeEach(() => {
    ({ tmpDir, localDir, meta } = setupMoveContext());
  });
  afterEach(() => {
    meta.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records failedMoves when cloud move throws', async () => {
    writeFileSync(join(localDir, 'x.md'), 'data');
    meta.setFileInfo(asRelPath('x.md'), {
      fileId: asFileId('f4'),
      cloudMtime: asEpochSeconds(1000),
      localMtime: asEpochSeconds(1000),
    });

    const stats = emptyStats();
    const api = makeMockApi();
    (api.moveFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('HTTP status: 404 not found'),
    );

    await handleMove({
      relPath: asRelPath('y.md'),
      state: { kind: 'moved', oldPath: asRelPath('x.md') },
      ctx: { api, meta, rootDirId: asDirId('root'), localDir },
      stats,
    });

    expect(existsSync(join(localDir, 'x.md'))).toBe(true);
    expect(stats.moved).toBe(0);
    expect(stats.errors).toBe(1);
    expect(stats.failedMoves).toHaveLength(1);
    expect(stats.failedMoves[0]?.oldPath).toBe(asRelPath('x.md'));
  });

  it('updates metadata to new path after move', async () => {
    writeFileSync(join(localDir, 'old.md'), 'data');
    meta.setFileInfo(asRelPath('old.md'), {
      fileId: asFileId('f5'),
      cloudMtime: asEpochSeconds(1000),
      localMtime: asEpochSeconds(1000),
    });

    const stats = emptyStats();
    await handleMove({
      relPath: asRelPath('new.md'),
      state: { kind: 'moved', oldPath: asRelPath('old.md') },
      ctx: { api: makeMockApi(), meta, rootDirId: asDirId('root'), localDir },
      stats,
    });

    expect(meta.getFileInfo(asRelPath('old.md'))).toBeNull();
    const newRecord = meta.getFileInfo(asRelPath('new.md'));
    expect(newRecord).not.toBeNull();
    expect(newRecord?.fileId).toBe('f5');
  });

  it('errors when old path has no metadata', async () => {
    const stats = emptyStats();
    const api = makeMockApi();

    await handleMove({
      relPath: asRelPath('new.md'),
      state: { kind: 'moved', oldPath: asRelPath('nonexistent.md') },
      ctx: { api, meta, rootDirId: asDirId('root'), localDir },
      stats,
    });

    expect(stats.moved).toBe(0);
    expect(stats.errors).toBe(1);
    expect(api.moveFile).not.toHaveBeenCalled();
  });

  it('skips non-moved states', async () => {
    const stats = emptyStats();
    const api = makeMockApi();

    await handleMove({
      relPath: asRelPath('x.md'),
      state: { kind: 'localNew' },
      ctx: { api, meta, rootDirId: asDirId('root'), localDir },
      stats,
    });

    expect(stats.moved).toBe(0);
    expect(api.moveFile).not.toHaveBeenCalled();
  });
});

describe('fallbackDeleteOldFiles', () => {
  let tmpDir: string;
  let meta: MetadataStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fallback-test-'));
    meta = new MetadataStore(join(tmpDir, 'meta.db'));
  });
  afterEach(() => {
    meta.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes old cloud file when newPath is in uploadedPaths', async () => {
    meta.setFileInfo(asRelPath('old.md'), {
      fileId: asFileId('f-old'),
      cloudMtime: asEpochSeconds(1000),
      localMtime: asEpochSeconds(1000),
    });

    const stats = emptyStats();
    stats.failedMoves.push({
      oldPath: asRelPath('old.md'),
      newPath: asRelPath('new.md'),
      fileId: asFileId('f-old'),
      domain: NoteDomain.MARKDOWN,
    });
    stats.uploadedPaths.add(asRelPath('new.md'));

    const deleteFile = vi.fn().mockResolvedValue({});
    await fallbackDeleteOldFiles(
      stats,
      { deleteFile: deleteFile as (id: FileId) => Promise<unknown> },
      meta,
    );

    expect(deleteFile).toHaveBeenCalledWith('f-old');
    expect(meta.getFileInfo(asRelPath('old.md'))).toBeNull();
  });

  it('skips deletion when newPath is NOT in uploadedPaths', async () => {
    meta.setFileInfo(asRelPath('old.md'), {
      fileId: asFileId('f-old'),
      cloudMtime: asEpochSeconds(1000),
      localMtime: asEpochSeconds(1000),
    });

    const stats = emptyStats();
    stats.failedMoves.push({
      oldPath: asRelPath('old.md'),
      newPath: asRelPath('new.md'),
      fileId: asFileId('f-old'),
      domain: NoteDomain.MARKDOWN,
    });
    // uploadedPaths is empty — newPath was NOT uploaded

    const deleteFile = vi.fn().mockResolvedValue({});
    await fallbackDeleteOldFiles(
      stats,
      { deleteFile: deleteFile as (id: FileId) => Promise<unknown> },
      meta,
    );

    expect(deleteFile).not.toHaveBeenCalled();
    expect(meta.getFileInfo(asRelPath('old.md'))).not.toBeNull();
  });

  it('handles deleteFile failure gracefully', async () => {
    meta.setFileInfo(asRelPath('old.md'), {
      fileId: asFileId('f-old'),
      cloudMtime: asEpochSeconds(1000),
      localMtime: asEpochSeconds(1000),
    });

    const stats = emptyStats();
    stats.failedMoves.push({
      oldPath: asRelPath('old.md'),
      newPath: asRelPath('new.md'),
      fileId: asFileId('f-old'),
      domain: NoteDomain.MARKDOWN,
    });
    stats.uploadedPaths.add(asRelPath('new.md'));

    const deleteFile = vi.fn().mockRejectedValue(new Error('cloud delete failed'));
    await fallbackDeleteOldFiles(
      stats,
      { deleteFile: deleteFile as (id: FileId) => Promise<unknown> },
      meta,
    );

    expect(deleteFile).toHaveBeenCalledWith('f-old');
    // metadata should still exist (delete failed, best-effort)
    expect(meta.getFileInfo(asRelPath('old.md'))).not.toBeNull();
  });
});
