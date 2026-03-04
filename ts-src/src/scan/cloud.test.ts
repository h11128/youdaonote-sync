import { describe, expect, it } from 'vitest';
import { scanCloud } from './cloud.js';
import type { DirBrowser } from './cloud.js';
import { asDirId } from '../types/common.js';

function mockApi(
  tree: Record<
    string,
    {
      id: string;
      name: string;
      dir?: boolean;
      modifyTimeForSort?: number;
      createTimeForSort?: number;
      domain?: number;
    }[]
  >,
): DirBrowser {
  return {
    getDirInfoById(dirId) {
      const entries = tree[dirId] ?? [];
      return Promise.resolve({
        entries: entries.map((e) => ({
          fileEntry: {
            id: e.id,
            name: e.name,
            dir: e.dir ?? false,
            modifyTimeForSort: e.modifyTimeForSort ?? 0,
            createTimeForSort: e.createTimeForSort ?? 0,
            domain: e.domain ?? 1,
          },
        })),
      });
    },
  };
}

describe('scanCloud', () => {
  it('returns files from a flat directory', async () => {
    const api = mockApi({
      'root-dir': [
        { id: 'f1', name: 'hello.md', modifyTimeForSort: 1000 },
        { id: 'f2', name: 'world.note', modifyTimeForSort: 2000 },
      ],
    });

    const result = await scanCloud(api, asDirId('root-dir'));

    expect(result.has('hello.md')).toBe(true);
    expect(result.has('world.md')).toBe(true); // .note → .md
    expect(result.get('hello.md')!.mtime).toBe(1000);
  });

  it('recurses into subdirectories', async () => {
    const api = mockApi({
      'root-dir': [
        { id: 'sub1', name: 'docs', dir: true },
        { id: 'f1', name: 'root.md' },
      ],
      sub1: [{ id: 'f2', name: 'nested.md' }],
    });

    const result = await scanCloud(api, asDirId('root-dir'));

    expect(result.has('root.md')).toBe(true);
    expect(result.has('docs')).toBe(true);
    expect(result.has('docs/nested.md')).toBe(true);
  });

  it('skips dot-prefixed entries', async () => {
    const api = mockApi({
      'root-dir': [
        { id: 'f1', name: '.hidden' },
        { id: 'f2', name: 'visible.md' },
      ],
    });

    const result = await scanCloud(api, asDirId('root-dir'));

    expect(result.has('.hidden')).toBe(false);
    expect(result.has('visible.md')).toBe(true);
  });

  it('throws on empty rootDirId', async () => {
    const api = mockApi({});
    await expect(scanCloud(api, asDirId(''))).rejects.toThrow();
  });

  it('handles API errors gracefully', async () => {
    const api: DirBrowser = {
      getDirInfoById: () => Promise.reject(new Error('network error')),
    };

    const result = await scanCloud(api, asDirId('root'));

    expect(result.size).toBe(0);
  });
});
