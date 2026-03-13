import { describe, expect, it, vi } from 'vitest';
import { fetchDirList, type DirListContext } from './dir.js';
import { asDirId } from '../types/common.js';

vi.mock('./constants.js', () => ({
  DIR_MES_URL: 'https://note.youdao.com/yws/api/personal/file/{dir_id}?len={page_size}&cstk={cstk}',
  DIR_PAGE_SIZE: 3,
  tpl: (url: string, vars: Record<string, string>) => {
    let r = url;
    for (const [k, v] of Object.entries(vars)) r = r.replaceAll(`{${k}}`, v);
    return r;
  },
}));

function makeMockCtx(responses: Record<string, unknown>[]): DirListContext & {
  calls: string[];
} {
  let callIndex = 0;
  const calls: string[] = [];

  const ctx: DirListContext & { calls: string[] } = {
    calls,
    httpGet: vi.fn((url: string) => {
      calls.push(url);
      const data = responses[callIndex] ?? { entries: [], count: 0 };
      callIndex++;
      return Promise.resolve(
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
    getCstk: () => 'test-cstk',
  };
  return ctx;
}

describe('fetchDirList — basic', () => {
  it('returns single page of entries', async () => {
    const ctx = makeMockCtx([
      {
        entries: [
          { fileEntry: { id: 'e1', name: 'note1' } },
          { fileEntry: { id: 'e2', name: 'note2' } },
        ],
        count: 2,
      },
    ]);

    const result = await fetchDirList(ctx, asDirId('root'));

    expect(ctx.httpGet).toHaveBeenCalledTimes(1);
    expect(result.count).toBe(2);
    expect(result.entries).toHaveLength(2);
    expect(result.entries![0]!.fileEntry.id).toBe('e1');
    expect(result.entries![1]!.fileEntry.id).toBe('e2');
  });

  it('fetches multiple pages when first page is full', async () => {
    const ctx = makeMockCtx([
      {
        entries: [
          { fileEntry: { id: 'e1', name: 'a' } },
          { fileEntry: { id: 'e2', name: 'b' } },
          { fileEntry: { id: 'e3', name: 'c' } },
        ],
        count: 5,
      },
      {
        entries: [{ fileEntry: { id: 'e4', name: 'd' } }, { fileEntry: { id: 'e5', name: 'e' } }],
        count: 5,
      },
    ]);

    const result = await fetchDirList(ctx, asDirId('dir123'));

    expect(ctx.httpGet).toHaveBeenCalledTimes(2);
    expect(ctx.calls[0]).not.toContain('startIndex');
    expect(ctx.calls[1]).toContain('startIndex=3');
    expect(result.count).toBe(5);
    expect(result.entries!.map((e) => e.fileEntry.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });
});

describe('fetchDirList — edge cases', () => {
  it('deduplicates entries by id across pages', async () => {
    const ctx = makeMockCtx([
      {
        entries: [
          { fileEntry: { id: 'dup', name: 'first' } },
          { fileEntry: { id: 'dup', name: 'second' } },
        ],
        count: 2,
      },
    ]);

    const result = await fetchDirList(ctx, asDirId('x'));

    expect(result.count).toBe(1);
    expect(result.entries![0]!.fileEntry.id).toBe('dup');
  });

  it('handles numeric id in fileEntry', async () => {
    const ctx = makeMockCtx([
      {
        entries: [{ fileEntry: { id: 12345, name: 'num' } }],
        count: 1,
      },
    ]);

    const result = await fetchDirList(ctx, asDirId('y'));

    expect(result.count).toBe(1);
    expect(result.entries![0]!.fileEntry.id).toBe(12345);
  });

  it('skips entries with empty id', async () => {
    const ctx = makeMockCtx([
      {
        entries: [
          { fileEntry: { id: '', name: 'empty' } },
          { fileEntry: { id: 'ok', name: 'valid' } },
        ],
        count: 2,
      },
    ]);

    const result = await fetchDirList(ctx, asDirId('z'));

    expect(result.count).toBe(1);
    expect(result.entries![0]!.fileEntry.id).toBe('ok');
  });

  it('stops when entries array is empty', async () => {
    const ctx = makeMockCtx([
      { entries: [{ fileEntry: { id: 'a', name: 'a' } }], count: 1 },
      { entries: [], count: 0 },
    ]);

    const result = await fetchDirList(ctx, asDirId('root'));

    expect(ctx.httpGet).toHaveBeenCalledTimes(1);
    expect(result.count).toBe(1);
  });

  it('stops when newCount is 0 (all duplicates)', async () => {
    const ctx = makeMockCtx([
      {
        entries: [
          { fileEntry: { id: 'a', name: 'a' } },
          { fileEntry: { id: 'b', name: 'b' } },
          { fileEntry: { id: 'c', name: 'c' } },
        ],
        count: 4,
      },
      {
        entries: [{ fileEntry: { id: 'a', name: 'dup' } }, { fileEntry: { id: 'b', name: 'dup' } }],
        count: 4,
      },
    ]);

    const result = await fetchDirList(ctx, asDirId('root'));

    expect(ctx.httpGet).toHaveBeenCalledTimes(2);
    expect(result.count).toBe(3);
  });
});
