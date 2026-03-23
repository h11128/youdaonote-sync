import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import type { FileState } from '../types/state.js';
import { asEpochSeconds, type FileId, type NoteDomain, type RelPath } from '../types/common.js';
import type { MetadataStore } from '../metadata/store.js';
import type { ExecuteContext, SyncStats } from './types.js';
import { ensureParentDir } from './upload.js';

export interface HandleMoveOpts {
  relPath: RelPath;
  state: FileState;
  ctx: ExecuteContext;
  stats: SyncStats;
}

async function moveCloudFile(opts: {
  relPath: RelPath;
  oldPath: RelPath;
  oldFileId: FileId;
  domain: NoteDomain;
  ctx: ExecuteContext;
  stats: SyncStats;
}): Promise<boolean> {
  const { relPath, oldPath, oldFileId, domain, ctx, stats } = opts;
  const { api, meta, rootDirId } = ctx;
  try {
    const newParentId = await ensureParentDir({
      api,
      meta,
      relPath,
      rootDirId,
      inflight: ctx.dirCreateInflight,
    });
    await api.moveFile(oldFileId, newParentId, domain);
    const oldName = basename(oldPath);
    const newName = basename(relPath);
    if (oldName !== newName) {
      await api.renameFile(oldFileId, newName, domain);
    }
    return true;
  } catch {
    stats.failedMoves.push({
      oldPath,
      newPath: relPath,
      fileId: oldFileId,
      domain,
    });
    return false;
  }
}

function moveLocalFile(localDir: string, oldPath: RelPath, relPath: RelPath): void {
  const oldAbs = join(localDir, oldPath);
  const newAbs = join(localDir, relPath);
  if (!existsSync(oldAbs) || oldAbs === newAbs) return;
  mkdirSync(dirname(newAbs), { recursive: true });
  renameSync(oldAbs, newAbs);
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
  const oldMeta = meta.getFileInfo(oldPath);
  if (!oldMeta?.fileId) {
    console.error(`Skip move ${relPath}: no metadata for old path ${oldPath}`);
    stats.errors++;
    return;
  }
  const oldFileId = oldMeta.fileId;

  const ok = await moveCloudFile({
    relPath,
    oldPath,
    oldFileId,
    domain: oldMeta.domain,
    ctx,
    stats,
  });
  if (!ok) {
    stats.errors++;
    return;
  }

  try {
    moveLocalFile(localDir, oldPath, relPath);
  } catch {
    /* best-effort */
  }

  const newLocalAbs = join(localDir, relPath);
  meta.renamePath(oldPath, relPath);
  const localMtime = existsSync(newLocalAbs)
    ? asEpochSeconds(Math.floor(statSync(newLocalAbs).mtimeMs / 1000))
    : asEpochSeconds(0);
  meta.recordSync(relPath, {
    fileId: oldFileId,
    cloudMtime: asEpochSeconds(Math.floor(Date.now() / 1000)),
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
