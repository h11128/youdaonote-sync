import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { YoudaoNoteApi } from '../api/client.js';
import { parseYoudaoPushError, YOUDAO_DUPLICATE_NAME } from '../api/push-errors.js';
import type { DirId, EpochSeconds, FileId, ContentHash, RelPath } from '../types/common.js';
import { joinRelPath } from '../types/common.js';
import { NoteDomain } from '../types/common.js';
import type { MetadataStore } from '../metadata/store.js';
import { markdownToNoteJson } from '../convert/md-to-note.js';
import { normalizeSep } from '../scan/name.js';
import { requireNonEmpty } from '../util/preconditions.js';
import { bindDiaryNoteTarget } from './diary-note-sibling.js';
import { needsOfficialNote } from '../scan/cloud-identity.js';
import { pushWithRecovery } from './upload-push.js';

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
  readonly domain?: NoteDomain;
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
  /** Cloud filename. Keep `.note` when updating a mapped official-app file. */
  existingName?: string;
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

function resultOf(
  fileId: FileId,
  result: Record<string, unknown>,
  parentId: DirId,
  domain?: NoteDomain,
): UploadResult {
  requireNonEmpty('upload.fileId', fileId);
  return {
    fileId,
    cloudMtime: extractCloudMtime(result),
    parentId,
    ...(domain != null ? { domain } : {}),
  };
}

async function listParentEntries(
  api: YoudaoNoteApi,
  parentId: DirId,
): Promise<{ name: string; id: string }[]> {
  const listed = await api.getDirInfoById(parentId);
  return (listed.entries ?? []).map((row) => ({
    name: row.fileEntry.name,
    id: row.fileEntry.id,
  }));
}

async function uploadBinary(o: {
  api: YoudaoNoteApi;
  fileId: FileId;
  parentId: DirId;
  name: string;
  isCreate: boolean;
  rawBuf: Buffer;
}): Promise<UploadResult> {
  const { fileId, result } = await pushWithRecovery({
    api: o.api,
    fileId: o.fileId,
    parentId: o.parentId,
    name: o.name,
    isCreate: o.isCreate,
    binary: true,
    fileData: new Uint8Array(o.rawBuf),
  });
  return resultOf(fileId, result, o.parentId);
}

async function uploadText(o: {
  api: YoudaoNoteApi;
  fileId: FileId;
  parentId: DirId;
  name: string;
  isCreate: boolean;
  ext: string;
  existingDomain?: NoteDomain;
  content: string;
}): Promise<UploadResult> {
  const bound = await bindDiaryNoteTarget({
    name: o.name,
    fileId: o.fileId,
    isCreate: o.isCreate,
    needsNote: needsOfficialNote(o.name, o.ext, o.existingDomain),
    listParent: () => listParentEntries(o.api, o.parentId),
  });
  const domain = bound.needsNote ? NoteDomain.NOTE : NoteDomain.MARKDOWN;
  const { fileId, result } = await pushWithRecovery({
    api: o.api,
    fileId: bound.fileId as FileId,
    parentId: o.parentId,
    name: bound.name,
    isCreate: bound.isCreate,
    binary: false,
    domain,
    bodyString: bound.needsNote ? markdownToNoteJson(o.content) : o.content,
  });
  return resultOf(fileId, result, o.parentId, domain);
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
  const name = opts.existingName ?? parts.pop() ?? basename(relPath);
  const rawBuf = opts.preReadBuffer ?? readFileSync(localPath);
  if (!isTextFile(ext)) {
    return uploadBinary({ api, fileId, parentId, name, isCreate, rawBuf });
  }
  return uploadText({
    api,
    fileId,
    parentId,
    name,
    isCreate,
    ext,
    content: rawBuf.toString('utf-8'),
    ...(opts.existingDomain != null ? { existingDomain: opts.existingDomain } : {}),
  });
}
