import { describe, expect, it, vi } from 'vitest';
import { getDirectoryEntries, searchByName, findFolderByPath, type SearchType } from './search.js';
import type { YoudaoNoteApi } from '../api/client.js';
import type { DirInfoByIdResponse } from '../types/dir.js';
import { asDirId } from '../types/common.js';

function makeMockApi(responses: Record<string, DirInfoByIdResponse>): YoudaoNoteApi {
  return {
    getRootId: vi.fn().mockResolvedValue('root-id'),
    getDirInfoById: vi.fn((dirId: string) => {
      const data = responses[dirId] ?? { entries: [] };
      return Promise.resolve(data);
    }),
  } as unknown as YoudaoNoteApi;
}

describe('getDirectoryEntries — root', () => {
  it('returns entries from root when dirId not provided', async () => {
    const api = makeMockApi({
      'root-id': {
        entries: [
          {
            fileEntry: {
              id: 'e1',
              name: 'note1.md',
              dir: false,
              size: 100,
              modifyTimeForSort: 1000,
              createTimeForSort: 900,
            },
          },
          {
            fileEntry: {
              id: 'e2',
              name: 'folder1',
              dir: true,
              modifyTimeForSort: 2000,
              createTimeForSort: 1900,
            },
          },
        ],
      },
    });

    const result = await getDirectoryEntries(api);

    expect(api.getRootId).toHaveBeenCalledTimes(1);
    expect(api.getDirInfoById).toHaveBeenCalledWith('root-id');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'e1',
      name: 'note1.md',
      isDir: false,
      size: 100,
      modifyTime: 1000,
      createTime: 900,
      entry: expect.objectContaining({ id: 'e1', name: 'note1.md' }),
    });
    expect(result[1]).toEqual({
      id: 'e2',
      name: 'folder1',
      isDir: true,
      size: 0,
      modifyTime: 2000,
      createTime: 1900,
      entry: expect.objectContaining({ id: 'e2', name: 'folder1' }),
    });
  });

  it('returns entries from specified dirId', async () => {
    const api = makeMockApi({
      'sub-dir': {
        entries: [
          {
            fileEntry: {
              id: 'f1',
              name: 'child.md',
              dir: false,
              modifyTimeForSort: 500,
              createTimeForSort: 400,
            },
          },
        ],
      },
    });

    const result = await getDirectoryEntries(api, asDirId('sub-dir'));

    expect(api.getRootId).not.toHaveBeenCalled();
    expect(api.getDirInfoById).toHaveBeenCalledWith('sub-dir');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('child.md');
  });
});

describe('getDirectoryEntries — mapping', () => {
  it('maps toDirectoryEntry correctly (size/modifyTime defaults)', async () => {
    const api = makeMockApi({
      'root-id': {
        entries: [
          {
            fileEntry: {
              id: 'x',
              name: 'minimal',
              dir: false,
            },
          },
        ],
      },
    });

    const result = await getDirectoryEntries(api);

    expect(result[0]).toMatchObject({
      id: 'x',
      name: 'minimal',
      isDir: false,
      size: 0,
      modifyTime: 0,
      createTime: 0,
    });
  });
});

describe('searchByName', () => {
  it('throws when name is empty', async () => {
    const api = makeMockApi({});

    await expect(searchByName(api, '')).rejects.toThrow('Search name must not be empty');
  });

  it('finds exact match when exactMatch=true', async () => {
    const api = makeMockApi({
      'root-id': {
        entries: [
          { fileEntry: { id: 'a', name: 'Foo', dir: false } },
          { fileEntry: { id: 'b', name: 'FooBar', dir: false } },
          { fileEntry: { id: 'c', name: 'foo', dir: false } },
        ],
      },
    });

    const result = await searchByName(api, 'Foo', 'all', true);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Foo');
  });

  it('finds partial match (case-insensitive) when exactMatch=false', async () => {
    const api = makeMockApi({
      'root-id': {
        entries: [
          { fileEntry: { id: 'a', name: 'Foo', dir: false } },
          { fileEntry: { id: 'b', name: 'FooBar', dir: false } },
          { fileEntry: { id: 'c', name: 'bar', dir: false } },
        ],
      },
    });

    const result = await searchByName(api, 'foo', 'all', false);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name).sort()).toEqual(['Foo', 'FooBar']);
  });

  for (const { type, expectDir } of [
    { type: 'folder' as SearchType, expectDir: true },
    { type: 'file' as SearchType, expectDir: false },
  ]) {
    it(`filters by searchType ${type}`, async () => {
      const api = makeMockApi({
        'root-id': {
          entries: [
            { fileEntry: { id: 'd1', name: 'target', dir: true } },
            { fileEntry: { id: 'f1', name: 'target', dir: false } },
          ],
        },
      });

      const result = await searchByName(api, 'target', type, false);

      expect(result).toHaveLength(1);
      expect(result[0]!.isDir).toBe(expectDir);
    });
  }
});

describe('searchByName — recursive', () => {
  it('recursively searches nested dirs', async () => {
    const api = makeMockApi({
      'root-id': {
        entries: [
          { fileEntry: { id: 'sub', name: 'docs', dir: true } },
          { fileEntry: { id: 'f1', name: 'root.md', dir: false } },
        ],
      },
      sub: {
        entries: [
          { fileEntry: { id: 'f2', name: 'nested-target.md', dir: false } },
          { fileEntry: { id: 'sub2', name: 'deep', dir: true } },
        ],
      },
      sub2: {
        entries: [{ fileEntry: { id: 'f3', name: 'target', dir: false } }],
      },
    });

    const result = await searchByName(api, 'target', 'all', false);

    expect(result).toHaveLength(2);
    const paths = result.map((r) => r.path).sort();
    expect(paths).toContain('docs/nested-target.md');
    expect(paths).toContain('docs/deep/target');
  });
});

describe('findFolderByPath', () => {
  it('returns root for empty or / path', async () => {
    const api = makeMockApi({});
    (api.getRootId as ReturnType<typeof vi.fn>).mockResolvedValue('root-id');

    expect(await findFolderByPath(api, '')).toBe('root-id');
    expect(await findFolderByPath(api, '/')).toBe('root-id');
    expect(api.getDirInfoById).not.toHaveBeenCalled();
  });

  it('finds folder by single segment', async () => {
    const api = makeMockApi({
      'root-id': {
        entries: [
          { fileEntry: { id: 'folder-a', name: 'Work', dir: true } },
          { fileEntry: { id: 'f1', name: 'file.md', dir: false } },
        ],
      },
    });

    const result = await findFolderByPath(api, 'Work');

    expect(result).toBe('folder-a');
  });

  it('finds nested folder by path', async () => {
    const api = makeMockApi({
      'root-id': {
        entries: [{ fileEntry: { id: 'p1', name: 'Projects', dir: true } }],
      },
      p1: {
        entries: [{ fileEntry: { id: 'p2', name: 'youdaonote-sync', dir: true } }],
      },
      p2: {
        entries: [{ fileEntry: { id: 'f1', name: 'readme.md', dir: false } }],
      },
    });

    const result = await findFolderByPath(api, 'Projects/youdaonote-sync');

    expect(result).toBe('p2');
  });

  it('returns null when folder not found', async () => {
    const api = makeMockApi({
      'root-id': {
        entries: [
          { fileEntry: { id: 'd1', name: 'Other', dir: true } },
          { fileEntry: { id: 'f1', name: 'target', dir: false } },
        ],
      },
    });

    const result = await findFolderByPath(api, 'Missing');

    expect(result).toBeNull();
  });

  it('returns null when intermediate path segment missing', async () => {
    const api = makeMockApi({
      'root-id': {
        entries: [{ fileEntry: { id: 'p1', name: 'Projects', dir: true } }],
      },
      p1: {
        entries: [{ fileEntry: { id: 'f1', name: 'readme.md', dir: false } }],
      },
    });

    const result = await findFolderByPath(api, 'Projects/nonexistent/sub');

    expect(result).toBeNull();
  });
});
