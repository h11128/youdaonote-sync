import { basename, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
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

/**
 * Handle move action: move cloud file to new parent, optionally rename.
 * Matches Python _execute_move.
 */
export async function handleMove(o: HandleMoveOpts): Promise<void> {
  const { relPath, state, cloudFile, ctx, stats } = o;
  if (state.kind !== 'moved') return;
  const { api, meta, rootDirId, localDir } = ctx;
  const oldPath = state.oldPath;
  const oldRecord = meta.getFileInfo(oldPath);
  const oldFileId = oldRecord?.fileId;

  if (!oldFileId || !cloudFile) return;

  let moveFailed = false;
  try {
    const newParentId = await ensureParentDir(api, meta, relPath, rootDirId);
    await retryWithBackoff(() => api.moveFile(oldFileId, newParentId, cloudFile.domain));
    const oldName = basename(oldPath);
    const newName = basename(relPath);
    if (oldName !== newName) {
      await retryWithBackoff(() => api.renameFile(oldFileId, newName, cloudFile.domain));
    }
  } catch {
    moveFailed = true;
    stats.failedMoves.push({
      oldPath,
      newPath: relPath,
      fileId: oldFileId,
      domain: cloudFile.domain,
    });
  }

  if (!moveFailed) {
    meta.renamePath(oldPath, relPath);
    const localAbsPath = join(localDir, relPath);
    const localMtime = existsSync(localAbsPath)
      ? Math.floor(statSync(localAbsPath).mtimeMs / 1000)
      : 0;
    meta.recordSync(relPath, {
      fileId: oldFileId,
      cloudMtime: Math.floor(Date.now() / 1000),
      localMtime,
      action: 'moved',
      direction: 'push',
    });
    stats.moved++;
  }
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
