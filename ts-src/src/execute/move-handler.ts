import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import type { FileState } from '../types/state.js';
import type { FileId } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { MetadataStore } from '../metadata/store.js';
import type { ExecuteContext, SyncStats } from './executor.js';
import { ensureParentDir } from './upload.js';
import { retryWithBackoff } from '../api/retry.js';

export interface HandleMoveOpts {
  relPath: string;
  state: FileState;
  cloudFile: CloudFile | undefined;
  ctx: ExecuteContext;
  stats: SyncStats;
}

async function moveCloudFile(
  o: HandleMoveOpts,
  oldFileId: FileId,
  oldPath: string,
): Promise<boolean> {
  const { relPath, cloudFile, ctx, stats } = o;
  const { api, meta, rootDirId } = ctx;
  if (!cloudFile) return false;
  try {
    const newParentId = await ensureParentDir(api, meta, relPath, rootDirId);
    await retryWithBackoff(() => api.moveFile(oldFileId, newParentId, cloudFile.domain));
    const oldName = basename(oldPath);
    const newName = basename(relPath);
    if (oldName !== newName) {
      await retryWithBackoff(() => api.renameFile(oldFileId, newName, cloudFile.domain));
    }
    return true;
  } catch {
    stats.failedMoves.push({
      oldPath,
      newPath: relPath,
      fileId: oldFileId,
      domain: cloudFile.domain,
    });
    return false;
  }
}

function moveLocalFile(localDir: string, oldPath: string, relPath: string): void {
  const oldAbs = join(localDir, oldPath);
  const newAbs = join(localDir, relPath);
  if (existsSync(oldAbs) && oldAbs !== newAbs) {
    mkdirSync(dirname(newAbs), { recursive: true });
    renameSync(oldAbs, newAbs);
  }
}

/**
 * Handle move action: move cloud file to new parent, optionally rename.
 * Matches Python _execute_move.
 */
export async function handleMove(o: HandleMoveOpts): Promise<void> {
  const { relPath, state, ctx, stats } = o;
  if (state.kind !== 'moved') return;
  const { meta, localDir } = ctx;
  const oldPath = state.oldPath;
  const oldFileId = meta.getFileInfo(oldPath)?.fileId;
  if (!oldFileId || !o.cloudFile) return;

  const ok = await moveCloudFile(o, oldFileId, oldPath);
  if (!ok) return;

  try {
    moveLocalFile(localDir, oldPath, relPath);
  } catch {
    /* best-effort */
  }

  const newLocalAbs = join(localDir, relPath);
  meta.renamePath(oldPath, relPath);
  const localMtime = existsSync(newLocalAbs) ? Math.floor(statSync(newLocalAbs).mtimeMs / 1000) : 0;
  meta.recordSync(relPath, {
    fileId: oldFileId,
    cloudMtime: Math.floor(Date.now() / 1000),
    localMtime,
    action: 'moved',
    direction: 'push',
  });
  stats.moved++;
  stats.changedPaths.push(newLocalAbs);
}

/**
 * Fallback for failed cloud moves: delete old cloud files if the new path was uploaded.
 * Matches Python _fallback_delete_old_files.
 */
export async function fallbackDeleteOldFiles(
  stats: SyncStats,
  api: { deleteFile(fileId: FileId): Promise<unknown> },
  meta: MetadataStore,
): Promise<void> {
  for (const fm of stats.failedMoves) {
    if (!stats.uploadedPaths.has(fm.newPath)) continue;
    try {
      await api.deleteFile(fm.fileId);
      meta.removeFileInfo(fm.oldPath);
    } catch {
      // best-effort cleanup
    }
  }
}
