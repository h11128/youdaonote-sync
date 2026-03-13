import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { YoudaoNoteApi } from '../api/client.js';
import type { DirId, EpochSeconds, FileId, ContentHash, RelPath } from '../types/common.js';
import { joinRelPath } from '../types/common.js';
import { NoteDomain } from '../types/common.js';
import type { MetadataStore } from '../metadata/store.js';
import { markdownToNoteJson } from '../convert/md-to-note.js';
import { normalizeSep } from '../scan/name.js';
import { requireNonEmpty } from '../util/preconditions.js';

const TEXT_EXTS = new Set([
  '.md',
  '.txt',
  '.html',
  '.htm',
  '.xml',
  '.json',
  '.css',
  '.js',
  '.csv',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.sh',
  '.bat',
  '.ps1',
  '.py',
  '.ts',
  '.jsx',
  '.tsx',
  '.vue',
  '.svelte',
  '.note',
  '.clip',
]);

export interface UploadResult {
  readonly fileId: FileId;
  readonly cloudMtime: EpochSeconds;
}

/**
 * Ensure all parent directories exist in the cloud, creating them as needed.
 * Returns the DirId of the immediate parent directory.
 */
export async function ensureParentDir(
  api: YoudaoNoteApi,
  meta: MetadataStore,
  relPath: RelPath,
  rootDirId: DirId,
): Promise<DirId> {
  const parts = normalizeSep(relPath).split('/');
  parts.pop(); // remove filename

  let parentId = rootDirId;
  let currentPath = '' as RelPath | '';

  for (const part of parts) {
    currentPath = joinRelPath(currentPath, part);

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
  relPath: RelPath;
  rootDirId: DirId;
  existingFileId?: FileId;
  hashFn?: (data: Uint8Array, path: string) => ContentHash | null;
}

function isTextFile(ext: string): boolean {
  return TEXT_EXTS.has(ext);
}

function extractCloudMtime(result: Record<string, unknown>): EpochSeconds {
  const entry = (result.entry ?? result.fileEntry ?? {}) as Record<string, unknown>;
  const mtimeVal = entry.modifyTimeForSort;
  return (typeof mtimeVal === 'number' ? mtimeVal : Math.floor(Date.now() / 1000)) as EpochSeconds;
}

/**
 * Upload a single local file to the cloud.
 *
 * - .md files: upload as Markdown (domain=1)
 * - .note/.clip: convert md→JSON then upload (domain=0)
 * - Binary files (PDF, images, etc.): upload via multipart/form-data
 * - Other text files: upload as Markdown domain
 */
export async function uploadFile(opts: UploadFileOpts): Promise<UploadResult> {
  requireNonEmpty('localPath', opts.localPath);
  requireNonEmpty('relPath', opts.relPath);
  requireNonEmpty('rootDirId', opts.rootDirId);
  const { api, meta, localPath, relPath, rootDirId } = opts;
  const parentId = await ensureParentDir(api, meta, relPath, rootDirId);
  const ext = extname(localPath).toLowerCase();
  const isCreate = !opts.existingFileId;
  const fileId = opts.existingFileId ?? YoudaoNoteApi.generateFileId();
  const parts = normalizeSep(relPath).split('/');
  const popped = parts.pop();
  const name: string = popped ?? basename(relPath);

  if (!isTextFile(ext)) {
    const fileData = new Uint8Array(readFileSync(localPath));
    const result = await api.pushBinaryFile({
      fileId,
      parentId,
      name,
      fileData,
      isCreate,
    });
    return { fileId, cloudMtime: extractCloudMtime(result) };
  }

  const content = readFileSync(localPath, 'utf-8');
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
  return { fileId, cloudMtime: extractCloudMtime(result) };
}
