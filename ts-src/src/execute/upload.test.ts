import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { uploadFile } from './upload.js';
import { MetadataStore } from '../metadata/store.js';
import { asDirId, asFileId, asRelPath } from '../types/common.js';
import type { YoudaoNoteApi } from '../api/client.js';

function makeMockApi(): YoudaoNoteApi {
  return {
    pushFile: vi.fn().mockResolvedValue({
      entry: { id: 'result-id', modifyTimeForSort: 9999 },
    }),
    pushBinaryFile: vi.fn().mockResolvedValue({
      entry: { id: 'bin-result', modifyTimeForSort: 9999 },
    }),
    createDir: vi.fn().mockResolvedValue({ fileEntry: { id: 'dir-1' } }),
    generateFileId: vi.fn().mockReturnValue(asFileId('gen-id')),
  } as unknown as YoudaoNoteApi;
}

function setupTestEnv() {
  let tmpDir = '';
  let localDir = '';
  let meta: MetadataStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'upload-test-'));
    localDir = join(tmpDir, 'notes');
    mkdirSync(localDir, { recursive: true });
    meta = new MetadataStore(join(tmpDir, 'meta.db'));
  });

  afterEach(() => {
    meta.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  return {
    get tmpDir() {
      return tmpDir;
    },
    get localDir() {
      return localDir;
    },
    get meta() {
      return meta;
    },
  };
}

describe('uploadFile: text routing', () => {
  const env = setupTestEnv();

  it('routes .md files to pushFile', async () => {
    const localPath = join(env.localDir, 'doc.md');
    writeFileSync(localPath, '# Hello');

    const api = makeMockApi();
    await uploadFile({
      api,
      meta: env.meta,
      localPath,
      relPath: asRelPath('doc.md'),
      rootDirId: asDirId('root'),
    });

    expect(api.pushFile).toHaveBeenCalled();
    expect(api.pushBinaryFile).not.toHaveBeenCalled();
  });

  it('routes .txt files to pushFile', async () => {
    const localPath = join(env.localDir, 'readme.txt');
    writeFileSync(localPath, 'plain text');

    const api = makeMockApi();
    await uploadFile({
      api,
      meta: env.meta,
      localPath,
      relPath: asRelPath('readme.txt'),
      rootDirId: asDirId('root'),
    });

    expect(api.pushFile).toHaveBeenCalled();
    expect(api.pushBinaryFile).not.toHaveBeenCalled();
  });

  it('uses existingFileId when provided', async () => {
    const localPath = join(env.localDir, 'doc.md');
    writeFileSync(localPath, '# Update');

    const api = makeMockApi();
    await uploadFile({
      api,
      meta: env.meta,
      localPath,
      relPath: asRelPath('doc.md'),
      rootDirId: asDirId('root'),
      existingFileId: asFileId('existing-123'),
    });

    const call = (api.pushFile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.fileId).toBe('existing-123');
    expect(call.isCreate).toBe(false);
  });
});

describe('uploadFile: binary routing', () => {
  const env = setupTestEnv();

  it('routes .pdf files to pushBinaryFile', async () => {
    const localPath = join(env.localDir, 'doc.pdf');
    writeFileSync(localPath, Buffer.from([0x25, 0x50, 0x44, 0x46]));

    const api = makeMockApi();
    await uploadFile({
      api,
      meta: env.meta,
      localPath,
      relPath: asRelPath('doc.pdf'),
      rootDirId: asDirId('root'),
    });

    expect(api.pushBinaryFile).toHaveBeenCalled();
    expect(api.pushFile).not.toHaveBeenCalled();

    const call = (api.pushBinaryFile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.name).toBe('doc.pdf');
    expect(call.fileData).toBeInstanceOf(Uint8Array);
  });

  it('routes .png files to pushBinaryFile', async () => {
    const localPath = join(env.localDir, 'image.png');
    writeFileSync(localPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const api = makeMockApi();
    await uploadFile({
      api,
      meta: env.meta,
      localPath,
      relPath: asRelPath('image.png'),
      rootDirId: asDirId('root'),
    });

    expect(api.pushBinaryFile).toHaveBeenCalled();
    expect(api.pushFile).not.toHaveBeenCalled();
  });

  it('routes .docx files to pushBinaryFile', async () => {
    const localPath = join(env.localDir, 'report.docx');
    writeFileSync(localPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const api = makeMockApi();
    await uploadFile({
      api,
      meta: env.meta,
      localPath,
      relPath: asRelPath('report.docx'),
      rootDirId: asDirId('root'),
    });

    expect(api.pushBinaryFile).toHaveBeenCalled();
    expect(api.pushFile).not.toHaveBeenCalled();
  });
});

describe('uploadFile: duplicate-name recovery', () => {
  const env = setupTestEnv();

  it('retries as save when create hits HTTP 500 duplicate 20108', async () => {
    const localPath = join(env.localDir, 'dup.md');
    writeFileSync(localPath, '# dup');

    const api = makeMockApi();
    vi.mocked(api.pushFile)
      .mockRejectedValueOnce(
        new Error(
          'HTTP 500: {"error":"20108","duplicateFileId":"WEB-existing","message":"Message[CLIENT : DUPLICATE_FILE_NAME]"}',
        ),
      )
      .mockResolvedValueOnce({
        entry: { id: 'WEB-existing', modifyTimeForSort: 1234 },
      });

    const result = await uploadFile({
      api,
      meta: env.meta,
      localPath,
      relPath: asRelPath('dup.md'),
      rootDirId: asDirId('root'),
    });

    expect(result.fileId).toBe('WEB-existing');
    expect(api.pushFile).toHaveBeenCalledTimes(2);
    const second = (api.pushFile as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    expect(second.fileId).toBe('WEB-existing');
    expect(second.isCreate).toBe(false);
  });

  it('retries once on VERSION_CONFLICT 211 for updates', async () => {
    const localPath = join(env.localDir, 'conflict.md');
    writeFileSync(localPath, '# conflict');

    const api = makeMockApi();
    vi.mocked(api.pushFile)
      .mockRejectedValueOnce(
        new Error('HTTP 500: {"error":"211","message":"Message[VERSION_CONFLICT]"}'),
      )
      .mockResolvedValueOnce({
        entry: { id: 'existing-123', modifyTimeForSort: 5555 },
      });

    const result = await uploadFile({
      api,
      meta: env.meta,
      localPath,
      relPath: asRelPath('conflict.md'),
      rootDirId: asDirId('root'),
      existingFileId: asFileId('existing-123'),
    });

    expect(result.fileId).toBe('existing-123');
    expect(api.pushFile).toHaveBeenCalledTimes(2);
  });
});
