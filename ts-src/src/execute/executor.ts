import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileState, SyncAction } from '../types/state.js';
import { stateToAction } from '../types/state.js';
import type { YoudaoNoteApi } from '../api/client.js';
import type { MetadataStore } from '../metadata/store.js';
import { NoteDomain } from '../types/common.js';
import type { ContentHash, DirId, FileId, SyncDirection } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { downloadFile } from './download.js';
import { uploadFile, ensureParentDir, type UploadFileOpts } from './upload.js';
import { conflictFallback, type ConflictOpts } from './conflict.js';
import { tryDiff3Merge } from './diff3-merge.js';
import { retryWithBackoff } from '../api/retry.js';
import { handleMove } from './move-handler.js';
import { migrateImages } from './images.js';

export interface SyncStats {
  downloaded: number;
  uploaded: number;
  skipped: number;
  conflicts: number;
  errors: number;
  moved: number;
  merged: number;
  readonly changedPaths: string[];
  readonly failedMoves: { oldPath: string; newPath: string; fileId: FileId; domain: number }[];
  readonly uploadedPaths: Set<string>;
}

export function emptyStats(): SyncStats {
  return {
    downloaded: 0,
    uploaded: 0,
    skipped: 0,
    conflicts: 0,
    errors: 0,
    moved: 0,
    merged: 0,
    changedPaths: [],
    failedMoves: [],
    uploadedPaths: new Set(),
  };
}

function readFileMtime(path: string, fallback?: number): number {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return fallback ?? Math.floor(Date.now() / 1000);
  }
}

export interface ExecuteContext {
  api: YoudaoNoteApi;
  meta: MetadataStore;
  rootDirId: DirId;
  localDir: string;
  hashFn?: (data: Uint8Array, path: string) => ContentHash | null;
}

/**
 * Execute all sync actions based on classified file states.
 *
 * Processes actions in order:
 * 1. Directories first (create parent dirs)
 * 2. Downloads
 * 3. Uploads
 * 4. Conflicts (try diff3 merge for .md/.txt, fallback to backup + download)
 * 5. Moves
 */
function partitionEntries(
  classified: ReadonlyMap<string, FileState>,
  cloud: ReadonlyMap<string, CloudFile>,
  stats: SyncStats,
): {
  dirEntries: [string, FileState, SyncAction][];
  fileEntries: [string, FileState, SyncAction][];
} {
  const dirEntries: [string, FileState, SyncAction][] = [];
  const fileEntries: [string, FileState, SyncAction][] = [];
  for (const [relPath, state] of classified) {
    const action = stateToAction(state);
    if (action === 'skip') {
      stats.skipped++;
      continue;
    }
    const isDir = cloud.get(relPath)?.isDir ?? false;
    (isDir ? dirEntries : fileEntries).push([relPath, state, action]);
  }
  return { dirEntries, fileEntries };
}

function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function executeAll(
  classified: ReadonlyMap<string, FileState>,
  cloud: ReadonlyMap<string, CloudFile>,
  ctx: ExecuteContext,
  direction: SyncDirection = 'both',
): Promise<SyncStats> {
  const stats = emptyStats();
  const { dirEntries, fileEntries } = partitionEntries(classified, cloud, stats);

  for (const [relPath, _state, action] of dirEntries) {
    try {
      await executeDir(relPath, action, ctx, stats);
    } catch (e: unknown) {
      stats.errors++;
      console.error(`Error processing dir ${relPath}: ${formatError(e)}`);
    }
  }

  for (const [relPath, state, action] of fileEntries) {
    try {
      await executeSingle({ relPath, state, action, cloud, ctx, stats, direction });
    } catch (e: unknown) {
      stats.errors++;
      console.error(`Error processing ${relPath}: ${formatError(e)}`);
    }
  }

  return Object.freeze(stats);
}

/**
 * Handle directory sync: download → create local dir, upload → create cloud dir.
 * Matches Python _execute_dir.
 */
async function executeDir(
  relPath: string,
  action: SyncAction,
  ctx: ExecuteContext,
  stats: SyncStats,
): Promise<void> {
  if (action === 'download') {
    mkdirSync(join(ctx.localDir, relPath), { recursive: true });
    stats.downloaded++;
  } else if (action === 'upload') {
    await ensureParentDir(ctx.api, ctx.meta, relPath + '/_placeholder', ctx.rootDirId);
    stats.uploaded++;
  } else {
    stats.skipped++;
  }
}

interface ExecuteSingleOpts {
  relPath: string;
  state: FileState;
  action: SyncAction;
  cloud: ReadonlyMap<string, CloudFile>;
  ctx: ExecuteContext;
  stats: SyncStats;
  direction: SyncDirection;
}

interface HandleDownloadOpts {
  relPath: string;
  localPath: string;
  cloudFile: CloudFile;
  ctx: ExecuteContext;
  stats: SyncStats;
}

async function handleDownload(o: HandleDownloadOpts): Promise<void> {
  const { relPath, localPath, cloudFile, ctx, stats } = o;
  const { api, meta } = ctx;
  const dlOpts: {
    cloudMtime?: number;
    hashFn?: (data: Uint8Array, path: string) => ContentHash | null;
  } = { cloudMtime: cloudFile.mtime };
  if (ctx.hashFn) dlOpts.hashFn = ctx.hashFn;
  const result = await retryWithBackoff(() =>
    downloadFile(api, cloudFile.id as FileId, localPath, dlOpts),
  );
  meta.recordSync(relPath, {
    fileId: cloudFile.id as FileId,
    cloudMtime: cloudFile.mtime,
    localMtime: readFileMtime(localPath, cloudFile.mtime),
    parentId: cloudFile.parentId,
    domain: cloudFile.domain,
    contentHash: result.contentHash,
    cloudContentHash: result.contentHash,
    action: 'download',
    direction: 'pull',
  });
  if (cloudFile.domain === NoteDomain.NOTE && result.contentHash) {
    meta.saveBaseContent(relPath, Buffer.from(result.rawData), result.contentHash);
  }
  try {
    const imagesDir = join(dirname(localPath), 'images');
    const attachDir = join(dirname(localPath), 'attachments');
    const cookie = api.getCookieHeader();
    await migrateImages(localPath, imagesDir, attachDir, { Cookie: cookie });
  } catch {
    /* image migration is best-effort */
  }
  stats.downloaded++;
  stats.changedPaths.push(localPath);
}

interface HandleUploadOpts {
  relPath: string;
  localPath: string;
  metaRecord: { fileId?: FileId } | undefined;
  ctx: ExecuteContext;
  stats: SyncStats;
}

async function handleUpload(o: HandleUploadOpts): Promise<void> {
  const { relPath, localPath, metaRecord, ctx, stats } = o;
  const { api, meta, rootDirId } = ctx;
  const uploadHash = ctx.hashFn != null ? ctx.hashFn(readFileSync(localPath), localPath) : null;
  if (uploadHash) {
    const existing = meta.findCloudFileByHash(uploadHash, relPath);
    if (existing) {
      stats.skipped++;
      return;
    }
  }
  const ulOpts: UploadFileOpts = {
    api,
    meta,
    localPath,
    relPath,
    rootDirId,
  };
  if (metaRecord?.fileId) ulOpts.existingFileId = metaRecord.fileId;
  if (ctx.hashFn) ulOpts.hashFn = ctx.hashFn;
  const result = await retryWithBackoff(() => uploadFile(ulOpts));
  meta.recordSync(relPath, {
    fileId: result.fileId,
    cloudMtime: result.cloudMtime,
    localMtime: readFileMtime(localPath),
    contentHash: uploadHash,
    action: 'upload',
    direction: 'push',
  });
  stats.uploaded++;
  stats.changedPaths.push(localPath);
  stats.uploadedPaths.add(relPath);
}

async function handleConflict(o: ConflictOpts): Promise<void> {
  const { relPath, localPath, cloudFile, ctx, stats, direction } = o;
  if (direction === 'both' && cloudFile) {
    const merged = await tryDiff3Merge(relPath, localPath, cloudFile, ctx);
    if (merged) {
      stats.merged++;
      stats.changedPaths.push(localPath);
      stats.uploadedPaths.add(relPath);
      return;
    }
  }
  await conflictFallback({ relPath, localPath, cloudFile, ctx, stats, direction });
}

async function executeSingle(opts: ExecuteSingleOpts): Promise<void> {
  const { relPath, state, action, cloud, ctx, stats, direction } = opts;
  const { localDir } = ctx;
  const localPath = `${localDir}/${relPath}`;
  const cloudFile = cloud.get(relPath);
  const metaRecord = ctx.meta.getFileInfo(relPath);

  const handlers: Record<SyncAction, () => Promise<void>> = {
    download: () => {
      if (!cloudFile) {
        console.error(`Skip download ${relPath}: missing cloud file info`);
        stats.errors++;
        return Promise.resolve();
      }
      return handleDownload({ relPath, localPath, cloudFile, ctx, stats });
    },
    upload: () =>
      handleUpload({ relPath, localPath, metaRecord: metaRecord ?? undefined, ctx, stats }),
    conflict: () => handleConflict({ relPath, localPath, cloudFile, ctx, stats, direction }),
    move: () => handleMove({ relPath, state, cloudFile, ctx, stats }),
    skip: () => Promise.resolve(),
  };
  const handler = handlers[action];
  await handler();
}
