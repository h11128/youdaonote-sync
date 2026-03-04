import { describe, expect, it, vi } from 'vitest';
import { pushBinaryFile, type FileApiContext } from './file-api.js';
import { asFileId, asDirId } from '../types/common.js';

function makeMockCtx(): FileApiContext & { lastCall: { url: string; body: unknown } | null } {
  const ctx = {
    lastCall: null as { url: string; body: unknown } | null,
    httpPost: vi.fn((url: string, body?: URLSearchParams | FormData) => {
      ctx.lastCall = { url, body };
      return Promise.resolve(
        new Response(JSON.stringify({ entry: { id: 'result-id', modifyTimeForSort: 9999 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
    getCstk: () => 'test-cstk',
    requireAuth: vi.fn(),
  };
  return ctx;
}

describe('pushBinaryFile', () => {
  it('sends FormData with file field', async () => {
    const ctx = makeMockCtx();
    const fileData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

    const result = await pushBinaryFile(ctx, {
      fileId: asFileId('f1'),
      parentId: asDirId('root'),
      name: 'photo.png',
      fileData,
      isCreate: true,
    });

    expect(ctx.httpPost).toHaveBeenCalledTimes(1);
    const [url, body] = vi.mocked(ctx.httpPost).mock.calls[0]!;
    expect(url).toContain('method=push');
    expect(body).toBeInstanceOf(FormData);

    const form = body as FormData;
    expect(form.get('fileId')).toBe('f1');
    expect(form.get('parentId')).toBe('root');
    expect(form.get('name')).toBe('photo.png');
    expect(form.get('req_from')).toBe('create');
    expect(form.has('file')).toBe(true);

    expect(result).toHaveProperty('entry');
  });

  it('sets req_from=save for non-create', async () => {
    const ctx = makeMockCtx();

    await pushBinaryFile(ctx, {
      fileId: asFileId('f2'),
      parentId: asDirId('root'),
      name: 'doc.pdf',
      fileData: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      isCreate: false,
    });

    const form = vi.mocked(ctx.httpPost).mock.calls[0]![1] as FormData;
    expect(form.get('req_from')).toBe('save');
    expect(form.has('name')).toBe(false);
  });

  it('throws on empty fileId', async () => {
    const ctx = makeMockCtx();
    await expect(
      pushBinaryFile(ctx, {
        fileId: '' as never,
        parentId: asDirId('root'),
        name: 'x.pdf',
        fileData: new Uint8Array(),
      }),
    ).rejects.toThrow('fileId');
  });

  it('throws on empty parentId', async () => {
    const ctx = makeMockCtx();
    await expect(
      pushBinaryFile(ctx, {
        fileId: asFileId('f1'),
        parentId: '' as never,
        name: 'x.pdf',
        fileData: new Uint8Array(),
      }),
    ).rejects.toThrow('parentId');
  });

  it('throws on empty name', async () => {
    const ctx = makeMockCtx();
    await expect(
      pushBinaryFile(ctx, {
        fileId: asFileId('f1'),
        parentId: asDirId('root'),
        name: '',
        fileData: new Uint8Array(),
      }),
    ).rejects.toThrow('name');
  });
});
