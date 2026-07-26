import { existsSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileState, SyncAction, SyncLogMetadata } from '../types/state.js';
import { stateToAction } from '../types/state.js';
import type { DirId, FileId, NoteDomain, RelPath, SyncDirection } from '../types/common.js';
import { asEpochSeconds, joinRelPath } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { handleDownload } from './download.js';
import { uploadFile, ensureParentDir, type UploadFileOpts } from './upload.js';
import { conflictFallback, type ConflictOpts } from './conflict.js';
import { tryDiff3Merge, type MergeResult } from './diff3-merge.js';

import { handleMove } from './move-handler.js';
import { pLimit } from '../util/concurrency.js';
import { readFileMtime } from '../util/utils.js';
import { emptyStats, type ExecuteContext, type SyncStats } from './types.js';
import { logger } from '../util/logger.js';

export { emptyStats, type ExecuteContext, type SyncStats } from './types.js';

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
interface PartitionOpts {
  classified: ReadonlyMap<RelPath, FileState>;
  cloud: ReadonlyMap<RelPath, CloudFile>;
  local: ReadonlyMap<RelPath, { isDir: boolean }> | undefined;
  stats: SyncStats;
  deleteOverrides?: ReadonlyMap<RelPath, 'deleteCloud' | 'deleteLocal'> | undefined;
  metadata?: ReadonlyMap<RelPath, SyncLogMetadata> | undefined;
}

function partitionEntries(opts: PartitionOpts): {
  dirEntries: [RelPath, FileState, SyncAction, SyncLogMetadata | undefined][];
  fileEntries: [RelPath, FileState, SyncAction, SyncLogMetadata | undefined][];
} {
  const { classified, cloud, local, stats, deleteOverrides, metadata } = opts;
  const dirEntries: [RelPath, FileState, SyncAction, SyncLogMetadata | undefined][] = [];
  const fileEntries: [RelPath, FileState, SyncAction, SyncLogMetadata | undefined][] = [];
  for (const [relPath, state] of classified) {
    const action = deleteOverrides?.get(relPath) ?? stateToAction(state);
    if (action === 'skip') {
      stats.skipped++;
      continue;
    }
    const isDir = cloud.get(relPath)?.isDir ?? local?.get(relPath)?.isDir ?? false;
    const logMeta = metadata?.get(relPath);
    (isDir ? dirEntries : fileEntries).push([relPath, state, action, logMeta]);
  }
  return { dirEntries, fileEntries };
}

function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function resolveUploadMeta(
  record: { fileId?: FileId; domain?: NoteDomain } | undefined,
  cloudFile: CloudFile | undefined,
): { fileId?: FileId; domain?: NoteDomain } | undefined {
  if (record != null) return record;
  const domain = cloudFile?.domain;
  return domain != null ? { domain } : undefined;
}

type Entry = [RelPath, FileState, SyncAction, SyncLogMetadata | undefined];

export interface ExecuteAllOpts {
  classified: ReadonlyMap<RelPath, FileState>;
  cloud: ReadonlyMap<RelPath, CloudFile>;
  ctx: ExecuteContext;
  direction?: SyncDirection | undefined;
  deleteOverrides?: ReadonlyMap<RelPath, 'deleteCloud' | 'deleteLocal'> | undefined;
  metadata?: ReadonlyMap<RelPath, SyncLogMetadata> | undefined;
}

export async function executeAll(opts: ExecuteAllOpts): Promise<SyncStats> {
  const { classified, cloud, ctx, deleteOverrides, metadata } = opts;
  const direction = opts.direction ?? 'both';
  const stats = emptyStats();
  const ctxWithInflight = {
    ...ctx,
    dirCreateInflight: ctx.dirCreateInflight ?? new Map<string, Promise<DirId>>(),
  };
  const { dirEntries, fileEntries } = partitionEntries({
    classified,
    cloud,
    local: ctx.localSnap,
    stats,
    deleteOverrides,
    metadata,
  });

  for (const [relPath, _state, action, logMeta] of dirEntries) {
    try {
      await executeDir(relPath, action, ctxWithInflight, stats, logMeta);
    } catch (e: unknown) {
      stats.errors++;
      const detail = formatError(e);
      stats.failedFiles.push({ path: relPath, action, error: detail });
      logger.error(`Error processing dir ${relPath}: ${detail}`);
    }
  }

  await runFileEntries(fileEntries, { cloud, ctx: ctxWithInflight, stats, direction });
  return Object.freeze(stats);
}

const ACTION_SYMBOLS: Partial<Record<SyncAction, string>> = {
  download: '↓',
  upload: '↑',
  conflict: '⚡',
  move: '→',
  deleteCloud: '🗑c',
  deleteLocal: '🗑l',
};

async function runFileEntries(
  fileEntries: Entry[],
  opts: {
    cloud: ReadonlyMap<RelPath, CloudFile>;
    ctx: ExecuteContext;
    stats: SyncStats;
    direction: SyncDirection;
  },
): Promise<void> {
  const { cloud, ctx, stats, direction } = opts;
  const downloads: Entry[] = [];
  const uploads: Entry[] = [];
  const others: Entry[] = [];
  for (const entry of fileEntries) {
    const action = entry[2];
    if (action === 'download') downloads.push(entry);
    else if (action === 'upload') uploads.push(entry);
    else others.push(entry);
  }

  const total = fileEntries.length;
  let done = 0;
  const concurrency = ctx.concurrency ?? 3;
  const limit = pLimit(concurrency);
  const run = async ([relPath, state, action, logMeta]: Entry): Promise<void> => {
    try {
      await executeSingle({ relPath, state, action, cloud, ctx, stats, direction, logMeta });
      done++;
      const sym = ACTION_SYMBOLS[action] ?? '?';
      logger.info(`[${done}/${total}] ${sym} ${relPath}`);
    } catch (e: unknown) {
      done++;
      stats.errors++;
      const detail = formatError(e);
      stats.failedFiles.push({ path: relPath, action, error: detail });
      logger.error(`[${done}/${total}] ✗ ${relPath}: ${detail}`);
    }
  };

  await Promise.all(downloads.map((e) => limit(() => run(e))));
  await Promise.all(uploads.map((e) => limit(() => run(e))));
  for (const entry of others) await run(entry);
}

/**
 * Handle directory sync: download → create local dir, upload → create cloud dir.
 * Matches Python _execute_dir.
 */
// eslint-disable-next-line max-params
async function executeDir(
  relPath: RelPath,
  action: SyncAction,
  ctx: ExecuteContext,
  stats: SyncStats,
  logMeta?: SyncLogMetadata,
): Promise<void> {
  if (action === 'download') {
    mkdirSync(join(ctx.localDir, relPath), { recursive: true });
    stats.downloaded++;
    if (logMeta) {
      ctx.meta.recordSync(relPath, {
        fileId: '' as FileId,
        cloudMtime: asEpochSeconds(0),
        localMtime: asEpochSeconds(0),
        action: 'download',
        direction: 'pull',
        ...logMeta,
      });
    }
  } else if (action === 'upload') {
    await ensureParentDir({
      api: ctx.api,
      meta: ctx.meta,
      relPath: joinRelPath(relPath, '_placeholder'),
      rootDirId: ctx.rootDirId,
      inflight: ctx.dirCreateInflight,
    });
    stats.uploaded++;
    if (logMeta) {
      ctx.meta.recordSync(relPath, {
        fileId: '' as FileId,
        cloudMtime: asEpochSeconds(0),
        localMtime: asEpochSeconds(0),
        action: 'upload',
        direction: 'push',
        ...logMeta,
      });
    }
  } else {
    stats.skipped++;
  }
}

interface ExecuteSingleOpts {
  relPath: RelPath;
  state: FileState;
  action: SyncAction;
  cloud: ReadonlyMap<RelPath, CloudFile>;
  ctx: ExecuteContext;
  stats: SyncStats;
  direction: SyncDirection;
  logMeta?: SyncLogMetadata | undefined;
}

async function handleUpload(o: {
  relPath: RelPath;
  localPath: string;
  metaRecord: { fileId?: FileId; domain?: NoteDomain } | undefined;
  ctx: ExecuteContext;
  stats: SyncStats;
  logMeta?: SyncLogMetadata | undefined;
}): Promise<void> {
  const { relPath, localPath, metaRecord, ctx, stats, logMeta } = o;
  const { api, meta, rootDirId } = ctx;
  // Read once, reuse for hash + upload
  const fileBuffer = readFileSync(localPath);
  const uploadHash = ctx.hashFn != null ? ctx.hashFn(fileBuffer, localPath) : null;
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
    preReadBuffer: fileBuffer,
    dirCreateInflight: ctx.dirCreateInflight,
  };
  if (metaRecord?.fileId) ulOpts.existingFileId = metaRecord.fileId;
  if (metaRecord?.domain != null) ulOpts.existingDomain = metaRecord.domain;
  if (ctx.hashFn) ulOpts.hashFn = ctx.hashFn;
  const result = await uploadFile(ulOpts);
  meta.recordSync(relPath, {
    fileId: result.fileId,
    cloudMtime: result.cloudMtime,
    localMtime: asEpochSeconds(readFileMtime(localPath)),
    contentHash: uploadHash,
    action: 'upload',
    direction: 'push',
    ...logMeta,
  });
  stats.uploaded++;
  stats.changedPaths.push(localPath);
  stats.uploadedPaths.add(relPath);
}

async function handleConflict(o: ConflictOpts): Promise<void> {
  const { relPath, localPath, cloudFile, ctx, stats, direction, logMeta } = o;
  if (direction === 'both' && cloudFile) {
    const mergeCtx = logMeta !== undefined ? { ...ctx, logMeta } : ctx;
    const mergeResult: MergeResult = await tryDiff3Merge(relPath, localPath, cloudFile, mergeCtx);
    if (mergeResult) {
      stats.merged++;
      stats.changedPaths.push(localPath);
      if (mergeResult === 'merged') stats.uploadedPaths.add(relPath);
      return;
    }
  }
  await conflictFallback({ relPath, localPath, cloudFile, ctx, stats, direction, logMeta });
}

export function trashPath(localDir: string, relPath: RelPath): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(localDir, '.trash', date, relPath);
}

function moveToTrash(filePath: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(filePath, dest);
}

async function handleDeleteCloud(o: {
  relPath: RelPath;
  cloudFile: CloudFile | undefined;
  ctx: ExecuteContext;
  stats: SyncStats;
  logMeta?: SyncLogMetadata | undefined;
}): Promise<void> {
  const { relPath, cloudFile, ctx, stats, logMeta } = o;
  if (!cloudFile?.id) {
    logger.error(`Skip deleteCloud ${relPath}: missing cloud file id`);
    stats.errors++;
    return;
  }
  await ctx.api.deleteFile(cloudFile.id as FileId);
  ctx.meta.removeFileInfo(relPath);
  stats.deletedCloud++;
  stats.changedPaths.push(join(ctx.localDir, relPath));
  // Record delete in sync log if needed (currently removeFileInfo doesn't log, but recordSync does)
  // For now, if it's a delete, we might want to log it explicitly if logMeta is provided
  if (logMeta) {
    ctx.meta.recordSync(relPath, {
      fileId: cloudFile.id as FileId,
      cloudMtime: cloudFile.mtime,
      localMtime: asEpochSeconds(0),
      action: 'deleteCloud',
      direction: 'push',
      ...logMeta,
    });
  }
}

function handleDeleteLocal(o: {
  relPath: RelPath;
  localPath: string;
  ctx: ExecuteContext;
  stats: SyncStats;
  logMeta?: SyncLogMetadata | undefined;
}): void {
  const { relPath, localPath, ctx, stats, logMeta } = o;
  if (!existsSync(localPath)) {
    ctx.meta.removeFileInfo(relPath);
    stats.deletedLocal++;
    if (logMeta) {
      ctx.meta.recordSync(relPath, {
        fileId: '' as FileId,
        cloudMtime: asEpochSeconds(0),
        localMtime: asEpochSeconds(0),
        action: 'deleteLocal',
        direction: 'pull',
        ...logMeta,
      });
    }
    return;
  }
  const dest = trashPath(ctx.localDir, relPath);
  moveToTrash(localPath, dest);
  ctx.meta.removeFileInfo(relPath);
  stats.deletedLocal++;
  stats.changedPaths.push(localPath);
  if (logMeta) {
    ctx.meta.recordSync(relPath, {
      fileId: '' as FileId,
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(0),
      action: 'deleteLocal',
      direction: 'pull',
      ...logMeta,
    });
  }
}

async function executeSingle(opts: ExecuteSingleOpts): Promise<void> {
  const { relPath, state, action, cloud, ctx, stats, direction, logMeta } = opts;
  const { localDir } = ctx;
  const canonicalPath = join(localDir, relPath);
  const localPath = ctx.localSnap?.get(relPath)?.path ?? canonicalPath;
  const cloudFile = cloud.get(relPath);
  const metaRecord = ctx.meta.getFileInfo(relPath);

  const handlers: Record<SyncAction, () => Promise<void>> = {
    download: () => {
      if (!cloudFile) {
        logger.error(`Skip download ${relPath}: missing cloud file info`);
        stats.errors++;
        return Promise.resolve();
      }
      return handleDownload({ relPath, localPath: canonicalPath, cloudFile, ctx, stats, logMeta });
    },
    upload: () => {
      const uploadMeta = resolveUploadMeta(metaRecord ?? undefined, cloudFile);
      return handleUpload({ relPath, localPath, metaRecord: uploadMeta, ctx, stats, logMeta });
    },
    conflict: () =>
      handleConflict({ relPath, localPath, cloudFile, ctx, stats, direction, logMeta }),
    move: () => handleMove({ relPath, state, ctx, stats, logMeta }),
    deleteCloud: () => handleDeleteCloud({ relPath, cloudFile, ctx, stats, logMeta }),
    deleteLocal: () => {
      handleDeleteLocal({ relPath, localPath, ctx, stats, logMeta });
      return Promise.resolve();
    },
    skip: () => Promise.resolve(),
  };
  const handler = handlers[action];
  await handler();
}
