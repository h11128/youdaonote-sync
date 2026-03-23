import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trashPath, executeAll } from './executor.js';
import type { ExecuteContext } from './types.js';
import { asRelPath, asEpochSeconds } from '../types/common.js';
import type { DirId, FileId, RelPath, NoteDomain } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { FileState } from '../types/state.js';
import type { YoudaoNoteApi } from '../api/client.js';
import type { MetadataStore } from '../metadata/store.js';

const noop = vi.fn();

describe('trashPath', () => {
  it('returns path under .trash with date and relPath', () => {
    const result = trashPath('/sync', asRelPath('notes/a.md'));
    expect(result).toMatch(/[/\\]\.trash[/\\]\d{4}-\d{2}-\d{2}[/\\]notes[/\\]a\.md$/);
  });

  it('uses current date in YYYY-MM-DD format', () => {
    const result = trashPath('/sync', asRelPath('b.md'));
    const today = new Date().toISOString().slice(0, 10);
    expect(result).toContain(today);
  });

  it('handles nested paths', () => {
    const result = trashPath('/sync', asRelPath('deep/nested/dir/file.txt'));
    expect(result).toContain('.trash');
    expect(result).toMatch(/deep[/\\]nested[/\\]dir[/\\]file\.txt$/);
  });
});

function makeCloudFile(id: string, name: string): CloudFile {
  return {
    id: id as FileId,
    parentId: 'root' as DirId,
    name,
    isDir: false,
    mtime: asEpochSeconds(1000),
    ctime: asEpochSeconds(500),
    domain: 0 as NoteDomain,
  };
}

function buildMockCtx(
  localDir: string,
  overrides?: Partial<{
    deletedIds: string[];
    removedPaths: string[];
  }>,
): ExecuteContext {
  const deletedIds = overrides?.deletedIds ?? [];
  const removedPaths = overrides?.removedPaths ?? [];
  return {
    api: {
      deleteFile: (id: FileId) => {
        deletedIds.push(id);
        return Promise.resolve({});
      },
    } as unknown as YoudaoNoteApi,
    meta: {
      getFileInfo: () => null,
      removeFileInfo: (p: RelPath) => {
        removedPaths.push(p);
      },
    } as unknown as MetadataStore,
    rootDirId: 'root' as DirId,
    localDir,
  };
}

function withTmpDir(fn: (localDir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'executor-test-'));
    const localDir = join(tmpDir, 'notes');
    mkdirSync(localDir, { recursive: true });
    try {
      await fn(localDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

describe('executeAll — deleteCloud', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(noop);
    vi.spyOn(console, 'error').mockImplementation(noop);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'calls API deleteFile and removes metadata',
    withTmpDir(async (localDir) => {
      const deletedIds: string[] = [];
      const removedPaths: string[] = [];
      const ctx = buildMockCtx(localDir, { deletedIds, removedPaths });

      const classified = new Map<RelPath, FileState>([
        [asRelPath('gone.md'), { kind: 'localDeleted' }],
      ]);
      const cloud = new Map<RelPath, CloudFile>([
        [asRelPath('gone.md'), makeCloudFile('f-gone', 'gone.md')],
      ]);
      const deleteOverrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
        [asRelPath('gone.md'), 'deleteCloud'],
      ]);

      const stats = await executeAll({ classified, cloud, ctx, deleteOverrides });

      expect(stats.deletedCloud).toBe(1);
      expect(deletedIds).toContain('f-gone');
      expect(removedPaths).toContain(asRelPath('gone.md'));
    }),
  );

  it(
    'records error when cloudFile is missing',
    withTmpDir(async (localDir) => {
      const ctx = buildMockCtx(localDir);

      const classified = new Map<RelPath, FileState>([
        [asRelPath('no-cloud.md'), { kind: 'localDeleted' }],
      ]);
      const cloud = new Map<RelPath, CloudFile>();
      const deleteOverrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
        [asRelPath('no-cloud.md'), 'deleteCloud'],
      ]);

      const stats = await executeAll({ classified, cloud, ctx, deleteOverrides });

      expect(stats.errors).toBe(1);
      expect(stats.deletedCloud).toBe(0);
    }),
  );
});

describe('executeAll — deleteLocal', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(noop);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'moves existing file to .trash',
    withTmpDir(async (localDir) => {
      const filePath = join(localDir, 'removed.md');
      writeFileSync(filePath, 'will be trashed');
      const removedPaths: string[] = [];
      const ctx = buildMockCtx(localDir, { removedPaths });

      const classified = new Map<RelPath, FileState>([
        [asRelPath('removed.md'), { kind: 'cloudDeleted' }],
      ]);
      const cloud = new Map<RelPath, CloudFile>();
      const deleteOverrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
        [asRelPath('removed.md'), 'deleteLocal'],
      ]);

      const stats = await executeAll({ classified, cloud, ctx, deleteOverrides });

      expect(stats.deletedLocal).toBe(1);
      expect(existsSync(filePath)).toBe(false);
      expect(removedPaths).toContain(asRelPath('removed.md'));

      const today = new Date().toISOString().slice(0, 10);
      expect(existsSync(join(localDir, '.trash', today, 'removed.md'))).toBe(true);
    }),
  );

  it(
    'still updates metadata when file is already gone',
    withTmpDir(async (localDir) => {
      const removedPaths: string[] = [];
      const ctx = buildMockCtx(localDir, { removedPaths });

      const classified = new Map<RelPath, FileState>([
        [asRelPath('already-gone.md'), { kind: 'cloudDeleted' }],
      ]);
      const cloud = new Map<RelPath, CloudFile>();
      const deleteOverrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
        [asRelPath('already-gone.md'), 'deleteLocal'],
      ]);

      const stats = await executeAll({ classified, cloud, ctx, deleteOverrides });

      expect(stats.deletedLocal).toBe(1);
      expect(removedPaths).toContain(asRelPath('already-gone.md'));
    }),
  );
});

describe('executeAll — failedFiles tracking', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(noop);
    vi.spyOn(console, 'error').mockImplementation(noop);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'records path, action, and error message for failed operations',
    withTmpDir(async (localDir) => {
      const ctx: ExecuteContext = {
        api: {
          deleteFile: () => Promise.reject(new Error('API timeout')),
        } as unknown as YoudaoNoteApi,
        meta: {
          getFileInfo: () => null,
          removeFileInfo: vi.fn(),
        } as unknown as MetadataStore,
        rootDirId: 'root' as DirId,
        localDir,
      };

      const classified = new Map<RelPath, FileState>([
        [asRelPath('fail.md'), { kind: 'localDeleted' }],
      ]);
      const cloud = new Map<RelPath, CloudFile>([
        [asRelPath('fail.md'), makeCloudFile('f-fail', 'fail.md')],
      ]);
      const deleteOverrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
        [asRelPath('fail.md'), 'deleteCloud'],
      ]);

      const stats = await executeAll({ classified, cloud, ctx, deleteOverrides });

      expect(stats.errors).toBe(1);
      expect(stats.failedFiles).toHaveLength(1);
      expect(stats.failedFiles[0]!.path).toBe(asRelPath('fail.md'));
      expect(stats.failedFiles[0]!.action).toBe('deleteCloud');
      expect(stats.failedFiles[0]!.error).toContain('API timeout');
    }),
  );
});
