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

export interface EnsureParentDirOpts {
  api: YoudaoNoteApi;
  meta: MetadataStore;
  relPath: RelPath;
  rootDirId: DirId;
  inflight?: Map<string, Promise<DirId>> | undefined;
}

/**
 * Ensure all parent directories exist in the cloud, creating them as needed.
 * Returns the DirId of the immediate parent directory.
 *
 * When `inflight` is provided, deduplicates concurrent createDir calls
 * for the same path within the same sync session.
 */
export async function ensureParentDir(o: EnsureParentDirOpts): Promise<DirId> {
  const { api, meta, relPath, rootDirId, inflight } = o;
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

    if (inflight) {
      const existing = inflight.get(currentPath);
      if (existing) {
        parentId = await existing;
        continue;
      }
    }

    const createPromise = (async () => {
      const result = await api.createDir(parentId, part);
      const fe = result.fileEntry as Record<string, unknown> | undefined;
      const newId = (fe?.id ?? '') as DirId;
      if (newId) {
        meta.setDirInfo(currentPath, newId, parentId);
        return newId;
      }
      return parentId;
    })();

    inflight?.set(currentPath, createPromise);
    try {
      parentId = await createPromise;
    } finally {
      inflight?.delete(currentPath);
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
  /** Domain of the existing cloud file (from metadata). When set, overrides extension-based domain detection. */
  existingDomain?: NoteDomain;
  hashFn?: (data: Uint8Array, path: string) => ContentHash | null;
  /** Pre-read file buffer to avoid redundant disk reads. */
  preReadBuffer?: Buffer;
  /** Per-session dedup map for concurrent directory creation. */
  dirCreateInflight?: Map<string, Promise<DirId>> | undefined;
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
  const parentId = await ensureParentDir({
    api,
    meta,
    relPath,
    rootDirId,
    inflight: opts.dirCreateInflight,
  });
  const ext = extname(localPath).toLowerCase();
  const isCreate = !opts.existingFileId;
  const fileId = opts.existingFileId ?? YoudaoNoteApi.generateFileId();
  const parts = normalizeSep(relPath).split('/');
  const popped = parts.pop();
  const name: string = popped ?? basename(relPath);

  const rawBuf = opts.preReadBuffer ?? readFileSync(localPath);

  if (!isTextFile(ext)) {
    const result = await api.pushBinaryFile({
      fileId,
      parentId,
      name,
      fileData: new Uint8Array(rawBuf),
      isCreate,
    });
    return { fileId, cloudMtime: extractCloudMtime(result) };
  }

  const content = rawBuf.toString('utf-8');
  const needsNote = ext === '.note' || ext === '.clip' || opts.existingDomain === NoteDomain.NOTE;
  const domain = needsNote ? NoteDomain.NOTE : NoteDomain.MARKDOWN;
  const bodyString = needsNote ? markdownToNoteJson(content) : content;

  const result = await api.pushFile({ fileId, parentId, name, domain, bodyString, isCreate });
  return { fileId, cloudMtime: extractCloudMtime(result) };
}
