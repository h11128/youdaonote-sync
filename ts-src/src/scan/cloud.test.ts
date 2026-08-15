import { describe, expect, it } from 'vitest';
import { scanCloud } from './cloud.js';
import type { DirBrowser } from './cloud.js';
import { asDirId, asRelPath } from '../types/common.js';

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

    expect(result.has(asRelPath('hello.md'))).toBe(true);
    expect(result.has(asRelPath('world.md'))).toBe(true); // .note → .md
    expect(result.get(asRelPath('hello.md'))!.mtime).toBe(1000);
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

    expect(result.has(asRelPath('root.md'))).toBe(true);
    expect(result.has(asRelPath('docs'))).toBe(true);
    expect(result.has(asRelPath('docs/nested.md'))).toBe(true);
  });

  it('skips dot-prefixed entries', async () => {
    const api = mockApi({
      'root-dir': [
        { id: 'f1', name: '.hidden' },
        { id: 'f2', name: 'visible.md' },
      ],
    });

    const result = await scanCloud(api, asDirId('root-dir'));

    expect(result.has(asRelPath('.hidden'))).toBe(false);
    expect(result.has(asRelPath('visible.md'))).toBe(true);
  });

  it('prefers .note over same-stem .md', async () => {
    const api = mockApi({
      'root-dir': [
        { id: 'md-id', name: '2026年8月13日.md', modifyTimeForSort: 9000 },
        { id: 'note-id', name: '2026年8月13日.note', modifyTimeForSort: 1000 },
      ],
    });

    const result = await scanCloud(api, asDirId('root-dir'));
    const hit = result.get(asRelPath('2026年8月13日.md'));
    expect(hit?.id).toBe('note-id');
    expect(hit?.name).toBe('2026年8月13日.note');
  });

  it('throws on empty rootDirId', async () => {
    const api = mockApi({});
    await expect(scanCloud(api, asDirId(''))).rejects.toThrow();
  });

  it('handles API errors gracefully', async () => {
    const api: DirBrowser = {
      getDirInfoById: () => Promise.reject(new Error('network error')),
    };

    const result = await scanCloud(api, asDirId('root'), { retryOpts: { maxRetries: 0 } });

    expect(result.size).toBe(0);
  });
});
