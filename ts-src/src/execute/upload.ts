import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { YoudaoNoteApi } from '../api/client.js';
import {
  parseYoudaoPushError,
  YOUDAO_DUPLICATE_NAME,
  YOUDAO_VERSION_CONFLICT,
} from '../api/push-errors.js';
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
  readonly parentId: DirId;
}

export interface EnsureParentDirOpts {
  api: YoudaoNoteApi;
  meta: MetadataStore;
  relPath: RelPath;
  rootDirId: DirId;
  inflight?: Map<string, Promise<DirId>> | undefined;
}

function entryId(result: Record<string, unknown>): string {
  const fe = (result.fileEntry ?? result.entry) as Record<string, unknown> | undefined;
  return typeof fe?.id === 'string' ? fe.id : '';
}

/**
 * Ensure all parent directories exist in the cloud, creating them as needed.
 * Returns the DirId of the immediate parent directory.
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

    const createPromise = createOrReuseDir({ api, meta, currentPath, parentId, part });
    inflight?.set(currentPath, createPromise);
    try {
      parentId = await createPromise;
    } finally {
      inflight?.delete(currentPath);
    }
  }

  return parentId;
}

interface CreateOrReuseDirOpts {
  api: YoudaoNoteApi;
  meta: MetadataStore;
  currentPath: RelPath | '';
  parentId: DirId;
  part: string;
}

async function createOrReuseDir(o: CreateOrReuseDirOpts): Promise<DirId> {
  const { api, meta, currentPath, parentId, part } = o;
  try {
    const result = await api.createDir(parentId, part);
    const newId = (entryId(result) ||
      (typeof result.duplicateFileId === 'string' ? result.duplicateFileId : '')) as DirId;
    if (!newId) {
      throw new Error(`createDir(${currentPath}) returned no directory id`);
    }
    meta.setDirInfo(currentPath as RelPath, newId, parentId);
    return newId;
  } catch (err: unknown) {
    const info = parseYoudaoPushError(err);
    if (info?.code === YOUDAO_DUPLICATE_NAME && info.duplicateFileId) {
      const dupId = info.duplicateFileId as DirId;
      meta.setDirInfo(currentPath as RelPath, dupId, parentId);
      return dupId;
    }
    throw err;
  }
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

type PushOnceOpts =
  | {
      api: YoudaoNoteApi;
      fileId: FileId;
      parentId: DirId;
      name: string;
      isCreate: boolean;
      binary: true;
      fileData: Uint8Array;
    }
  | {
      api: YoudaoNoteApi;
      fileId: FileId;
      parentId: DirId;
      name: string;
      isCreate: boolean;
      binary: false;
      domain: NoteDomain;
      bodyString: string;
    };

async function pushOnce(opts: PushOnceOpts): Promise<Record<string, unknown>> {
  if (opts.binary) {
    return opts.api.pushBinaryFile({
      fileId: opts.fileId,
      parentId: opts.parentId,
      name: opts.name,
      fileData: opts.fileData,
      isCreate: opts.isCreate,
    });
  }
  return opts.api.pushFile({
    fileId: opts.fileId,
    parentId: opts.parentId,
    name: opts.name,
    domain: opts.domain,
    bodyString: opts.bodyString,
    isCreate: opts.isCreate,
  });
}

/**
 * Push with recovery for duplicate-name (20108) and version-conflict (211).
 * HTTP 500 bodies and HTTP 200 error fields are both handled.
 */
async function pushWithRecovery(
  opts: PushOnceOpts,
): Promise<{ fileId: FileId; result: Record<string, unknown> }> {
  try {
    const result = await pushOnce(opts);
    const dupFromBody =
      typeof result.duplicateFileId === 'string' ? result.duplicateFileId : undefined;
    if (dupFromBody && opts.isCreate) {
      return await pushWithRecovery({ ...opts, fileId: dupFromBody as FileId, isCreate: false });
    }
    return { fileId: opts.fileId, result };
  } catch (err: unknown) {
    const info = parseYoudaoPushError(err);
    if (info?.code === YOUDAO_DUPLICATE_NAME && info.duplicateFileId && opts.isCreate) {
      return await pushWithRecovery({
        ...opts,
        fileId: info.duplicateFileId as FileId,
        isCreate: false,
      });
    }
    if (info?.code === YOUDAO_VERSION_CONFLICT && !opts.isCreate) {
      const result = await pushOnce({ ...opts, isCreate: false });
      return { fileId: opts.fileId, result };
    }
    throw err;
  }
}

/**
 * Upload a single local file to the cloud.
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
    const { fileId: resolvedId, result } = await pushWithRecovery({
      api,
      fileId,
      parentId,
      name,
      isCreate,
      binary: true,
      fileData: new Uint8Array(rawBuf),
    });
    return { fileId: resolvedId, cloudMtime: extractCloudMtime(result), parentId };
  }

  const content = rawBuf.toString('utf-8');
  const needsNote = ext === '.note' || ext === '.clip' || opts.existingDomain === NoteDomain.NOTE;
  const domain = needsNote ? NoteDomain.NOTE : NoteDomain.MARKDOWN;
  const bodyString = needsNote ? markdownToNoteJson(content) : content;

  const { fileId: resolvedId, result } = await pushWithRecovery({
    api,
    fileId,
    parentId,
    name,
    isCreate,
    binary: false,
    domain,
    bodyString,
  });
  return { fileId: resolvedId, cloudMtime: extractCloudMtime(result), parentId };
}
