import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleMove } from './move-handler.js';
import { emptyStats } from './executor.js';
import { MetadataStore } from '../metadata/store.js';
import { asDirId, asFileId } from '../types/common.js';
import type { NoteDomain } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { YoudaoNoteApi } from '../api/client.js';

function makeMockApi(): YoudaoNoteApi {
  return {
    moveFile: vi.fn().mockResolvedValue({}),
    renameFile: vi.fn().mockResolvedValue({}),
    createDir: vi.fn().mockResolvedValue({ fileEntry: { id: 'dir-1' } }),
  } as unknown as YoudaoNoteApi;
}

function makeCloudFile(id: string, name: string): CloudFile {
  return {
    id: asFileId(id),
    parentId: asDirId('root'),
    name,
    isDir: false,
    mtime: 1000,
    ctime: 900,
    domain: 1 as NoteDomain,
  };
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
    meta.setFileInfo('old-name.md', {
      fileId: asFileId('f1'),
      cloudMtime: 1000,
      localMtime: 1000,
    });

    const stats = emptyStats();
    await handleMove({
      relPath: 'new-name.md',
      state: { kind: 'moved', oldPath: 'old-name.md' },
      cloudFile: makeCloudFile('f1', 'new-name.md'),
      ctx: { api: makeMockApi(), meta, rootDirId: asDirId('root'), localDir },
      stats,
    });

    expect(existsSync(join(localDir, 'old-name.md'))).toBe(false);
    expect(existsSync(join(localDir, 'new-name.md'))).toBe(true);
    expect(readFileSync(join(localDir, 'new-name.md'), 'utf-8')).toBe(oldContent);
  });

  it('creates parent directories when moving to a subdirectory', async () => {
    writeFileSync(join(localDir, 'note.md'), 'content');
    meta.setFileInfo('note.md', {
      fileId: asFileId('f2'),
      cloudMtime: 1000,
      localMtime: 1000,
    });

    const stats = emptyStats();
    await handleMove({
      relPath: 'subdir/deep/note.md',
      state: { kind: 'moved', oldPath: 'note.md' },
      cloudFile: makeCloudFile('f2', 'note.md'),
      ctx: { api: makeMockApi(), meta, rootDirId: asDirId('root'), localDir },
      stats,
    });

    expect(existsSync(join(localDir, 'subdir', 'deep', 'note.md'))).toBe(true);
    expect(existsSync(join(localDir, 'note.md'))).toBe(false);
  });

  it('records moved path in changedPaths for git commit', async () => {
    writeFileSync(join(localDir, 'a.md'), 'data');
    meta.setFileInfo('a.md', {
      fileId: asFileId('f3'),
      cloudMtime: 1000,
      localMtime: 1000,
    });

    const stats = emptyStats();
    await handleMove({
      relPath: 'b.md',
      state: { kind: 'moved', oldPath: 'a.md' },
      cloudFile: makeCloudFile('f3', 'b.md'),
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
    meta.setFileInfo('x.md', {
      fileId: asFileId('f4'),
      cloudMtime: 1000,
      localMtime: 1000,
    });

    const stats = emptyStats();
    const api = makeMockApi();
    (api.moveFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('HTTP status: 404 not found'),
    );

    await handleMove({
      relPath: 'y.md',
      state: { kind: 'moved', oldPath: 'x.md' },
      cloudFile: makeCloudFile('f4', 'y.md'),
      ctx: { api, meta, rootDirId: asDirId('root'), localDir },
      stats,
    });

    expect(existsSync(join(localDir, 'x.md'))).toBe(true);
    expect(stats.moved).toBe(0);
    expect(stats.failedMoves).toHaveLength(1);
    expect(stats.failedMoves[0]?.oldPath).toBe('x.md');
  });

  it('updates metadata to new path after move', async () => {
    writeFileSync(join(localDir, 'old.md'), 'data');
    meta.setFileInfo('old.md', {
      fileId: asFileId('f5'),
      cloudMtime: 1000,
      localMtime: 1000,
    });

    const stats = emptyStats();
    await handleMove({
      relPath: 'new.md',
      state: { kind: 'moved', oldPath: 'old.md' },
      cloudFile: makeCloudFile('f5', 'new.md'),
      ctx: { api: makeMockApi(), meta, rootDirId: asDirId('root'), localDir },
      stats,
    });

    expect(meta.getFileInfo('old.md')).toBeNull();
    const newRecord = meta.getFileInfo('new.md');
    expect(newRecord).not.toBeNull();
    expect(newRecord?.fileId).toBe('f5');
  });

  it('skips non-moved states', async () => {
    const stats = emptyStats();
    const api = makeMockApi();

    await handleMove({
      relPath: 'x.md',
      state: { kind: 'localNew' },
      cloudFile: makeCloudFile('f6', 'x.md'),
      ctx: { api, meta, rootDirId: asDirId('root'), localDir },
      stats,
    });

    expect(stats.moved).toBe(0);
    expect(api.moveFile).not.toHaveBeenCalled();
  });
});
