/**
 * Shared helpers for E2E tests: mock API, cloud entry factory, temp context setup.
 */
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { YoudaoNoteApi } from '../api/client.js';
import type { DirInfoByIdResponse } from '../types/dir.js';
import { asDirId } from '../types/common.js';
import type { FileId } from '../types/common.js';

export interface MakeCloudEntryOpts {
  parentId?: string;
  dir?: boolean;
  domain?: number;
}

export function makeCloudEntry(
  id: string,
  name: string,
  mtime: number,
  opts?: MakeCloudEntryOpts,
): { fileEntry: Record<string, unknown> } {
  const parentId = opts?.parentId ?? 'root';
  return {
    fileEntry: {
      id,
      name,
      parentId,
      dir: opts?.dir ?? false,
      modifyTimeForSort: mtime,
      createTimeForSort: mtime - 1000,
      domain: opts?.domain ?? 1,
    },
  };
}

export interface MockApiRecorder {
  pushed: { name: string; body: string; isCreate?: boolean; fileId?: string }[];
  deleted: string[];
  moved: string[];
  dirs: string[];
}

export function buildMockApi(
  cloudEntries: Record<string, unknown>[],
  cloudFiles: Map<string, string>,
  recorder?: MockApiRecorder,
): YoudaoNoteApi {
  return {
    loginByCookies: () => null,
    getRootId: () => Promise.resolve(asDirId('root-dir')),
    getDirInfoById: () => Promise.resolve({ entries: cloudEntries } as DirInfoByIdResponse),
    getFileById: (fileId: FileId) => {
      const content = cloudFiles.get(fileId);
      if (!content) throw new Error(`File not found: ${fileId}`);
      return Promise.resolve(new TextEncoder().encode(content).buffer);
    },
    pushFile: (opts: Record<string, unknown>) => {
      recorder?.pushed.push({
        name: opts.name as string,
        body: opts.bodyString as string,
        isCreate: Boolean(opts.isCreate),
        fileId: typeof opts.fileId === 'string' ? opts.fileId : '',
      });
      return Promise.resolve({
        entry: { id: opts.fileId ?? 'new-id', modifyTimeForSort: Math.floor(Date.now() / 1000) },
      });
    },
    createDir: (_parentId: unknown, name: unknown) => {
      recorder?.dirs.push(name as string);
      return Promise.resolve({ fileEntry: { id: `dir-${String(name)}` } });
    },
    deleteFile: (fileId: FileId) => {
      recorder?.deleted.push(fileId);
      return Promise.resolve({});
    },
    moveFile: (fileId: FileId) => {
      recorder?.moved.push(fileId);
      return Promise.resolve({});
    },
    renameFile: () => Promise.resolve({}),
    listRecent: () => Promise.resolve([]),
  } as unknown as YoudaoNoteApi;
}

export function setupE2EContext(): {
  tmpDir: string;
  localDir: string;
  metaPath: string;
  cleanup: () => void;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const localDir = join(tmpDir, 'notes');
  const metaPath = join(tmpDir, 'meta.db');
  mkdirSync(localDir, { recursive: true });
  return {
    tmpDir,
    localDir,
    metaPath,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
