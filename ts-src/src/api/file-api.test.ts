import { describe, expect, it, vi } from 'vitest';
import {
  pushBinaryFile,
  pushFile,
  createDir,
  deleteFile,
  moveFile,
  renameFile,
  type FileApiContext,
} from './file-api.js';
import { asFileId, asDirId, NoteDomain } from '../types/common.js';

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

  const emptyFieldCases = [
    {
      name: 'fileId',
      args: {
        fileId: '' as never,
        parentId: asDirId('root'),
        name: 'x.pdf',
        fileData: new Uint8Array(),
      },
    },
    {
      name: 'parentId',
      args: {
        fileId: asFileId('f1'),
        parentId: '' as never,
        name: 'x.pdf',
        fileData: new Uint8Array(),
      },
    },
    {
      name: 'name',
      args: {
        fileId: asFileId('f1'),
        parentId: asDirId('root'),
        name: '',
        fileData: new Uint8Array(),
      },
    },
  ];

  for (const { name: field, args } of emptyFieldCases) {
    it(`throws on empty ${field}`, async () => {
      await expect(pushBinaryFile(makeMockCtx(), args)).rejects.toThrow(field);
    });
  }
});

describe('pushFile', () => {
  it('sends URLSearchParams with bodyString and req_from=create', async () => {
    const ctx = makeMockCtx();

    const result = await pushFile(ctx, {
      fileId: asFileId('f1'),
      parentId: asDirId('root'),
      name: 'note.md',
      domain: NoteDomain.MARKDOWN,
      bodyString: '# Hello',
      isCreate: true,
    });

    expect(ctx.requireAuth).toHaveBeenCalled();
    expect(ctx.httpPost).toHaveBeenCalledTimes(1);
    const params = vi.mocked(ctx.httpPost).mock.calls[0]![1] as URLSearchParams;
    expect(params.get('fileId')).toBe('f1');
    expect(params.get('parentId')).toBe('root');
    expect(params.get('name')).toBe('note.md');
    expect(params.get('req_from')).toBe('create');
    expect(params.get('bodyString')).toBe('# Hello');
    expect(params.get('domain')).toBe('1');
    expect(result).toHaveProperty('entry');
  });

  it('sets req_from=save for non-create', async () => {
    const ctx = makeMockCtx();

    await pushFile(ctx, {
      fileId: asFileId('f2'),
      parentId: asDirId('root'),
      name: 'note.md',
      domain: NoteDomain.MARKDOWN,
      bodyString: 'content',
      isCreate: false,
    });

    const params = vi.mocked(ctx.httpPost).mock.calls[0]![1] as URLSearchParams;
    expect(params.get('req_from')).toBe('save');
  });

  it('sets editorVersion and summary for NOTE domain', async () => {
    const ctx = makeMockCtx();

    await pushFile(ctx, {
      fileId: asFileId('f3'),
      parentId: asDirId('root'),
      name: 'note',
      domain: NoteDomain.NOTE,
      bodyString: 'A'.repeat(100),
      isCreate: true,
    });

    const params = vi.mocked(ctx.httpPost).mock.calls[0]![1] as URLSearchParams;
    expect(params.get('editorVersion')).toBe('1714445486000');
    expect(params.get('summary')).toBe('A'.repeat(50));
  });
});

describe('createDir', () => {
  it('sends dir=true and uses generated fileId', async () => {
    const ctx = makeMockCtx();
    const genId = vi.fn().mockReturnValue(asFileId('gen-dir-id'));

    const result = await createDir(ctx, asDirId('parent'), 'New Folder', genId);

    expect(genId).toHaveBeenCalledTimes(1);
    const params = vi.mocked(ctx.httpPost).mock.calls[0]![1] as URLSearchParams;
    expect(params.get('fileId')).toBe('gen-dir-id');
    expect(params.get('parentId')).toBe('parent');
    expect(params.get('name')).toBe('New Folder');
    expect(params.get('dir')).toBe('true');
    expect(params.get('domain')).toBe('0');
    expect(result).toHaveProperty('entry');
  });

  it('returns fileEntry with duplicateFileId when error 20108', async () => {
    const ctx = makeMockCtx();
    vi.mocked(ctx.httpPost).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: '20108',
          duplicateFileId: 'existing-dir-id',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await createDir(ctx, asDirId('parent'), 'Dup Folder', () => asFileId('new-id'));

    expect(result.fileEntry).toEqual({
      id: 'existing-dir-id',
      name: 'Dup Folder',
      dir: true,
    });
  });

  for (const { name: field, parentId, dirName } of [
    { name: 'parentId', parentId: '' as never, dirName: 'x' },
    { name: 'name', parentId: asDirId('p'), dirName: '' },
  ]) {
    it(`throws on empty ${field}`, async () => {
      await expect(
        createDir(makeMockCtx(), parentId, dirName, () => asFileId('id')),
      ).rejects.toThrow(field);
    });
  }
});

describe('deleteFile', () => {
  it('sends DELETE request with file_id in url', async () => {
    const ctx = makeMockCtx();

    const result = await deleteFile(ctx, asFileId('file-to-delete'));

    expect(ctx.httpPost).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(ctx.httpPost).mock.calls[0]!;
    expect(url).toContain('method=delete');
    expect(url).toContain('file-to-delete');
    expect(result).toBeDefined();
  });

  it('throws on empty fileId', async () => {
    await expect(deleteFile(makeMockCtx(), '' as never)).rejects.toThrow('fileId');
  });
});

describe('moveFile', () => {
  it('sends parentId as new parent', async () => {
    const ctx = makeMockCtx();

    await moveFile(ctx, asFileId('f1'), asDirId('new-parent'));

    const params = vi.mocked(ctx.httpPost).mock.calls[0]![1] as URLSearchParams;
    expect(params.get('fileId')).toBe('f1');
    expect(params.get('parentId')).toBe('new-parent');
    expect(params.get('domain')).toBe('1');
  });

  it('uses custom domain when provided', async () => {
    const ctx = makeMockCtx();

    await moveFile(ctx, asFileId('f1'), asDirId('p'), 0);

    const params = vi.mocked(ctx.httpPost).mock.calls[0]![1] as URLSearchParams;
    expect(params.get('domain')).toBe('0');
  });

  for (const { name: field, fileId, parentId } of [
    { name: 'fileId', fileId: '' as never, parentId: asDirId('p') },
    { name: 'newParentId', fileId: asFileId('f1'), parentId: '' as never },
  ]) {
    it(`throws on empty ${field}`, async () => {
      await expect(moveFile(makeMockCtx(), fileId, parentId)).rejects.toThrow(field);
    });
  }
});

describe('renameFile', () => {
  it('sends name in url and returns result', async () => {
    const ctx = makeMockCtx();

    const result = await renameFile(ctx, asFileId('f1'), 'New Name.md');

    expect(ctx.httpPost).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(ctx.httpPost).mock.calls[0]!;
    expect(url).toContain('name=');
    expect(url).toContain(encodeURIComponent('New Name.md'));
    expect(url).toContain('fileId=f1');
    expect(result).toBeDefined();
  });

  for (const { name: field, fileId, newName } of [
    { name: 'fileId', fileId: '' as never, newName: 'x' },
    { name: 'newName', fileId: asFileId('f1'), newName: '' },
  ]) {
    it(`throws on empty ${field}`, async () => {
      await expect(renameFile(makeMockCtx(), fileId, newName)).rejects.toThrow(field);
    });
  }
});
