/**
 * Per-action execute handlers extracted from executor.ts (300-line budget).
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileId, NoteDomain, RelPath } from '../types/common.js';
import { asEpochSeconds } from '../types/common.js';
import type { SyncLogMetadata } from '../types/state.js';
import type { CloudFile } from '../types/scan.js';
import { isUnusableContentHash } from '../algo/content-hash.js';
import { readFileMtime } from '../util/utils.js';
import { logger } from '../util/logger.js';
import { uploadFile, type UploadFileOpts } from './upload.js';
import { conflictFallback, type ConflictOpts } from './conflict.js';
import { tryDiff3Merge, type MergeResult } from './diff3-merge.js';
import type { ExecuteContext, SyncStats } from './types.js';

export async function handleUpload(o: {
  relPath: RelPath;
  localPath: string;
  metaRecord: { fileId?: FileId; domain?: NoteDomain } | undefined;
  ctx: ExecuteContext;
  stats: SyncStats;
  logMeta?: SyncLogMetadata | undefined;
}): Promise<void> {
  const { relPath, localPath, metaRecord, ctx, stats, logMeta } = o;
  const { api, meta, rootDirId } = ctx;
  const fileBuffer = readFileSync(localPath);
  const rawUploadHash = ctx.hashFn != null ? ctx.hashFn(fileBuffer, localPath) : null;
  const uploadHash = isUnusableContentHash(rawUploadHash) ? null : rawUploadHash;
  // Intentionally no findCloudFileByHash short-circuit: skipping left the path as
  // perpetual localNew (no file_id written) and blocked legitimate same-content copies.
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
    parentId: result.parentId,
    contentHash: uploadHash,
    action: 'upload',
    direction: 'push',
    ...logMeta,
  });
  stats.uploaded++;
  stats.changedPaths.push(localPath);
  stats.uploadedPaths.add(relPath);
}

export async function handleConflict(o: ConflictOpts): Promise<void> {
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

export async function handleDeleteCloud(o: {
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
  stats.deletedCloud++;
  stats.changedPaths.push(join(ctx.localDir, relPath));
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
  // recordSync upserts the files row — remove after logging so deletes stay gone.
  ctx.meta.removeFileInfo(relPath);
}

export function handleDeleteLocal(o: {
  relPath: RelPath;
  localPath: string;
  ctx: ExecuteContext;
  stats: SyncStats;
  logMeta?: SyncLogMetadata | undefined;
}): void {
  const { relPath, localPath, ctx, stats, logMeta } = o;
  if (!existsSync(localPath)) {
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
    ctx.meta.removeFileInfo(relPath);
    stats.deletedLocal++;
    return;
  }
  const dest = trashPath(ctx.localDir, relPath);
  moveToTrash(localPath, dest);
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
  ctx.meta.removeFileInfo(relPath);
}
