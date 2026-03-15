import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import {
  asEpochSeconds,
  type ContentHash,
  type EpochSeconds,
  type FileId,
  type RelPath,
  type SyncDirection,
} from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { downloadFile } from './download.js';
import { uploadFile, type UploadFileOpts } from './upload.js';
import type { ExecuteContext, SyncStats } from './types.js';
import { retryWithBackoff } from '../api/retry.js';
import { readFileMtime } from '../util/utils.js';

/**
 * Create a conflict backup of a file.
 * Returns the backup path, or null if the source doesn't exist.
 */
export function backupFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  const now = new Date();
  const ts =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0') +
    '_' +
    String(now.getMilliseconds()).padStart(3, '0') +
    String(Math.floor(Math.random() * 1000)).padStart(3, '0');

  const ext = extname(filePath);
  const base = filePath.slice(0, -ext.length || undefined);
  const backupPath = `${base}.conflict.${ts}${ext}`;

  try {
    copyFileSync(filePath, backupPath);
    return backupPath;
  } catch (e: unknown) {
    console.warn(`[conflict] failed to backup ${filePath}: ${String(e)}`);
    return null;
  }
}

export interface ConflictOpts {
  relPath: RelPath;
  localPath: string;
  cloudFile: CloudFile | undefined;
  ctx: ExecuteContext;
  stats: SyncStats;
  direction: SyncDirection;
}

/**
 * Conflict fallback branching on sync direction (matches Python _do_conflict).
 */
export async function conflictFallback(opts: ConflictOpts): Promise<void> {
  if (opts.direction === 'push') return conflictPushFallback(opts);
  return conflictPullFallback(opts);
}

async function conflictPushFallback(opts: ConflictOpts): Promise<void> {
  const { relPath, localPath, cloudFile, ctx, stats } = opts;
  const { api, meta, rootDirId } = ctx;
  if (existsSync(localPath)) {
    backupFile(localPath);
  } else {
    /* no local file to backup, proceed with upload */
  }
  // Read once, reuse for upload + hash
  const fileBuffer = existsSync(localPath) ? readFileSync(localPath) : undefined;
  const ulOpts: UploadFileOpts = { api, meta, localPath, relPath, rootDirId };
  if (fileBuffer) ulOpts.preReadBuffer = fileBuffer;
  if (cloudFile?.id) ulOpts.existingFileId = cloudFile.id as FileId;
  if (ctx.hashFn) ulOpts.hashFn = ctx.hashFn;
  const result = await retryWithBackoff(() => uploadFile(ulOpts));
  meta.recordSync(relPath, {
    fileId: result.fileId,
    cloudMtime: result.cloudMtime,
    localMtime: asEpochSeconds(readFileMtime(localPath)),
    contentHash: ctx.hashFn && fileBuffer ? ctx.hashFn(fileBuffer, localPath) : null,
    action: 'conflict-upload',
    direction: 'push',
  });
  stats.uploaded++;
  stats.conflicts++;
  stats.changedPaths.push(localPath);
  stats.uploadedPaths.add(relPath);
}

async function conflictPullFallback(opts: ConflictOpts): Promise<void> {
  const { relPath, localPath, cloudFile, ctx, stats } = opts;
  const { api, meta } = ctx;
  if (existsSync(localPath)) backupFile(localPath);
  if (!cloudFile) {
    throw new Error(`conflictPullFallback: cloudFile required for ${relPath}`);
  }
  const dlOpts: {
    cloudMtime?: EpochSeconds;
    hashFn?: (data: Uint8Array, path: string) => ContentHash | null;
  } = { cloudMtime: cloudFile.mtime };
  if (ctx.hashFn) dlOpts.hashFn = ctx.hashFn;
  const result = await retryWithBackoff(() =>
    downloadFile(api, cloudFile.id as FileId, localPath, dlOpts),
  );
  meta.recordSync(relPath, {
    fileId: cloudFile.id as FileId,
    cloudMtime: cloudFile.mtime,
    localMtime: asEpochSeconds(readFileMtime(localPath, cloudFile.mtime)),
    parentId: cloudFile.parentId,
    domain: cloudFile.domain,
    contentHash: result.contentHash,
    action: 'conflict-download',
    direction: 'pull',
  });
  stats.conflicts++;
  stats.changedPaths.push(localPath);
}
