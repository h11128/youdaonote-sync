import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pullAll, downloadFolder } from './pull.js';
import type { YoudaoNoteApi } from '../api/client.js';
import type { DirInfoByIdResponse } from '../types/dir.js';
import { asDirId } from '../types/common.js';

function makeMockApi(
  dirTree: Record<string, DirInfoByIdResponse>,
  fileContents: Map<string, string>,
): YoudaoNoteApi {
  return {
    getRootId: vi.fn().mockResolvedValue('root-id'),
    getDirInfoById: vi.fn((dirId: string) => {
      const data = dirTree[dirId] ?? { entries: [] };
      return Promise.resolve(data);
    }),
    getFileById: vi.fn((fileId: string) => {
      const content = fileContents.get(fileId) ?? '# default';
      return Promise.resolve(new TextEncoder().encode(content).buffer);
    }),
  } as unknown as YoudaoNoteApi;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pull-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('downloadFolder', () => {
  it('downloads files and subdirs recursively', async () => {
    const localDir = join(tmpDir, 'output');
    const api = makeMockApi(
      {
        'folder-id': {
          entries: [
            {
              fileEntry: {
                id: 'f1',
                name: 'readme.md',
                dir: false,
                modifyTimeForSort: 1000,
              },
            },
            {
              fileEntry: {
                id: 'd1',
                name: 'sub',
                dir: true,
              },
            },
          ],
        },
        d1: {
          entries: [
            {
              fileEntry: {
                id: 'f2',
                name: 'nested.md',
                dir: false,
                modifyTimeForSort: 2000,
              },
            },
          ],
        },
      },
      new Map([
        ['f1', '# Root readme'],
        ['f2', '# Nested content'],
      ]),
    );

    const stats = await downloadFolder(api, asDirId('folder-id'), localDir);

    expect(stats.total).toBe(2);
    expect(stats.succeeded).toBe(2);
    expect(stats.failed).toBe(0);

    expect(existsSync(join(localDir, 'readme.md'))).toBe(true);
    expect(existsSync(join(localDir, 'sub', 'nested.md'))).toBe(true);
    expect(readFileSync(join(localDir, 'readme.md'), 'utf-8')).toBe('# Root readme');
    expect(readFileSync(join(localDir, 'sub', 'nested.md'), 'utf-8')).toBe('# Nested content');
  });

  it('returns correct stats when some downloads fail', async () => {
    const localDir = join(tmpDir, 'output');
    const api = makeMockApi(
      {
        'folder-id': {
          entries: [
            { fileEntry: { id: 'ok', name: 'ok.md', dir: false } },
            { fileEntry: { id: 'fail', name: 'fail.md', dir: false } },
          ],
        },
      },
      new Map([['ok', 'content']]),
    );
    (api.getFileById as ReturnType<typeof vi.fn>).mockImplementation((fileId: string) => {
      if (fileId === 'fail') return Promise.reject(new Error('Network error'));
      return Promise.resolve(new TextEncoder().encode('content').buffer);
    });

    const stats = await downloadFolder(api, asDirId('folder-id'), localDir);

    expect(stats.total).toBe(2);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);
  });
});

describe('pullAll', () => {
  it('uses getRootId when ydnoteDir not provided', async () => {
    const localDir = join(tmpDir, 'notes');
    const api = makeMockApi(
      {
        'root-id': {
          entries: [
            {
              fileEntry: {
                id: 'f1',
                name: 'root.md',
                dir: false,
                modifyTimeForSort: 1000,
              },
            },
          ],
        },
      },
      new Map([['f1', '# Root']]),
    );

    const stats = await pullAll(api, localDir);

    expect(api.getRootId).toHaveBeenCalled();
    expect(stats.total).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect(existsSync(join(localDir, 'root.md'))).toBe(true);
  });

  it('uses findFolderByPath when ydnoteDir provided', async () => {
    const localDir = join(tmpDir, 'notes');
    const api = makeMockApi(
      {
        'root-id': {
          entries: [{ fileEntry: { id: 'work', name: 'Work', dir: true } }],
        },
        work: {
          entries: [
            {
              fileEntry: {
                id: 'f1',
                name: 'project.md',
                dir: false,
                modifyTimeForSort: 1000,
              },
            },
          ],
        },
      },
      new Map([['f1', '# Project']]),
    );

    const stats = await pullAll(api, localDir, 'Work');

    expect(api.getDirInfoById).toHaveBeenCalledWith('root-id');
    expect(api.getDirInfoById).toHaveBeenCalledWith('work');
    expect(stats.total).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect(existsSync(join(localDir, 'project.md'))).toBe(true);
  });

  it('throws when ydnoteDir folder not found', async () => {
    const localDir = join(tmpDir, 'notes');
    const api = makeMockApi(
      {
        'root-id': {
          entries: [{ fileEntry: { id: 'other', name: 'Other', dir: true } }],
        },
      },
      new Map(),
    );

    await expect(pullAll(api, localDir, 'Missing')).rejects.toThrow('Cloud folder not found');
  });
});
