import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { YoudaoNoteApi } from '../api/client.js';
import type { DirId, FileId, ContentHash } from '../types/common.js';
import { NoteDomain } from '../types/common.js';
import type { MetadataStore } from '../metadata/store.js';
import { markdownToNoteJson } from '../convert/md-to-note.js';
import { normalizeSep } from '../scan/name.js';

export interface UploadResult {
  readonly fileId: FileId;
  readonly cloudMtime: number;
}

/**
 * Ensure all parent directories exist in the cloud, creating them as needed.
 * Returns the DirId of the immediate parent directory.
 */
export async function ensureParentDir(
  api: YoudaoNoteApi,
  meta: MetadataStore,
  relPath: string,
  rootDirId: DirId,
): Promise<DirId> {
  const parts = normalizeSep(relPath).split('/');
  parts.pop(); // remove filename

  let parentId = rootDirId;
  let currentPath = '';

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;

    const cached = meta.getDirId(currentPath);
    if (cached) {
      parentId = cached;
      continue;
    }

    const result = await api.createDir(parentId, part);
    const fe = result.fileEntry as Record<string, unknown> | undefined;
    const newId = (fe?.id ?? '') as DirId;
    if (newId) {
      meta.setDirInfo(currentPath, newId, parentId);
      parentId = newId;
    }
  }

  return parentId;
}

export interface UploadFileOpts {
  api: YoudaoNoteApi;
  meta: MetadataStore;
  localPath: string;
  relPath: string;
  rootDirId: DirId;
  existingFileId?: FileId;
  hashFn?: (data: Uint8Array, path: string) => ContentHash | null;
}

/**
 * Upload a single local file to the cloud.
 *
 * - .md files: upload as Markdown (domain=1)
 * - Other text: try markdown push, fallback to binary
 */
export async function uploadFile(opts: UploadFileOpts): Promise<UploadResult> {
  const { api, meta, localPath, relPath, rootDirId } = opts;
  const parentId = await ensureParentDir(api, meta, relPath, rootDirId);
  const ext = extname(localPath).toLowerCase();
  const content = readFileSync(localPath, 'utf-8');
  const isCreate = !opts.existingFileId;
  const fileId = opts.existingFileId ?? YoudaoNoteApi.generateFileId();
  const parts = normalizeSep(relPath).split('/');
  const popped = parts.pop();
  const name: string = popped ?? basename(relPath);

  let domain = NoteDomain.MARKDOWN;
  let bodyString = content;

  if (ext === '.note' || ext === '.clip') {
    domain = NoteDomain.NOTE;
    bodyString = markdownToNoteJson(content);
  }

  const result = await api.pushFile({
    fileId,
    parentId,
    name,
    domain,
    bodyString,
    isCreate,
  });

  const entry = (result.entry ?? result.fileEntry ?? {}) as Record<string, unknown>;
  const mtimeVal = entry.modifyTimeForSort;
  const cloudMtime: number =
    typeof mtimeVal === 'number' ? mtimeVal : Math.floor(Date.now() / 1000);

  return { fileId, cloudMtime };
}
