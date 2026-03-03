import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { FileState, SyncAction } from '../types/state.js';
import { stateToAction } from '../types/state.js';
import type { YoudaoNoteApi } from '../api/client.js';
import type { MetadataStore } from '../metadata/store.js';
import type { ContentHash, DirId, FileId } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { downloadFile } from './download.js';
import { uploadFile, ensureParentDir } from './upload.js';
import { backupFile } from './conflict.js';
import { threeWayMerge } from '../algo/merge.js';
import { retryWithBackoff } from '../api/retry.js';
import { getFileContentFromGit } from '../git.js';

const MERGEABLE_EXTS = new Set(['.md', '.txt']);

export interface SyncStats {
  downloaded: number;
  uploaded: number;
  skipped: number;
  conflicts: number;
  errors: number;
  moved: number;
  merged: number;
  readonly changedPaths: string[];
  readonly failedMoves: Array<{ oldPath: string; newPath: string; fileId: FileId; domain: number }>;
  readonly uploadedPaths: Set<string>;
}

export function emptyStats(): SyncStats {
  return {
    downloaded: 0, uploaded: 0, skipped: 0, conflicts: 0, errors: 0, moved: 0, merged: 0,
    changedPaths: [], failedMoves: [], uploadedPaths: new Set(),
  };
}

export interface ExecuteContext {
  api: YoudaoNoteApi;
  meta: MetadataStore;
  rootDirId: DirId;
  localDir: string;
  hashFn?: ((data: Uint8Array, path: string) => ContentHash | null) | undefined;
  dryRun?: boolean | undefined;
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
export async function executeAll(
  classified: ReadonlyMap<string, FileState>,
  cloud: ReadonlyMap<string, CloudFile>,
  ctx: ExecuteContext,
): Promise<SyncStats> {
  const stats = emptyStats();

  for (const [relPath, state] of classified) {
    const action = stateToAction(state);

    if (action === 'skip') {
      stats.skipped++;
      continue;
    }

    if (ctx.dryRun) {
      countAction(stats, action);
      continue;
    }

    try {
      await executeSingle(relPath, state, action, cloud, ctx, stats);
    } catch (e: unknown) {
      stats.errors++;
      console.error(`Error processing ${relPath}: ${e}`);
    }
  }

  return Object.freeze(stats) as Readonly<SyncStats>;
}

function countAction(stats: SyncStats, action: SyncAction): void {
  switch (action) {
    case 'download': stats.downloaded++; break;
    case 'upload': stats.uploaded++; break;
    case 'conflict': stats.conflicts++; break;
    case 'move': stats.moved++; break;
  }
}

async function executeSingle(
  relPath: string,
  state: FileState,
  action: SyncAction,
  cloud: ReadonlyMap<string, CloudFile>,
  ctx: ExecuteContext,
  stats: SyncStats,
): Promise<void> {
  const { api, meta, rootDirId, localDir } = ctx;
  const localPath = `${localDir}/${relPath}`;
  const cloudFile = cloud.get(relPath);
  const metaRecord = meta.getFileInfo(relPath);

  switch (action) {
    case 'download': {
      if (!cloudFile) return;
      const dlOpts: { cloudMtime?: number; hashFn?: (data: Uint8Array, path: string) => ContentHash | null } = {
        cloudMtime: cloudFile.mtime,
      };
      if (ctx.hashFn) dlOpts.hashFn = ctx.hashFn;
      const result = await retryWithBackoff(() => downloadFile(api, cloudFile.id, localPath, dlOpts));
      meta.recordSync(relPath, {
        fileId: cloudFile.id,
        cloudMtime: cloudFile.mtime,
        localMtime: Math.floor(Date.now() / 1000),
        parentId: cloudFile.parentId,
        domain: cloudFile.domain,
        contentHash: result.contentHash,
        cloudContentHash: result.contentHash,
        action: 'download',
        direction: 'pull',
      });

      // Save base for diff3 merge (domain=0 = note XML format)
      if (cloudFile.domain === 0 && result.contentHash && result.rawData) {
        meta.saveBaseContent(relPath, Buffer.from(result.rawData), result.contentHash);
      }

      stats.downloaded++;
      stats.changedPaths.push(localPath);
      break;
    }

    case 'upload': {
      // Skip upload if same content already exists in cloud (dedup)
      const uploadHash = ctx.hashFn
        ? ctx.hashFn(readFileSync(localPath), localPath)
        : null;
      if (uploadHash) {
        const existing = meta.findCloudFileByHash(uploadHash, relPath);
        if (existing) {
          stats.skipped++;
          break;
        }
      }

      const existingFileId = metaRecord?.fileId as FileId | undefined;
      const ulOpts: { existingFileId?: FileId; hashFn?: (data: Uint8Array, path: string) => ContentHash | null } = {};
      if (existingFileId) ulOpts.existingFileId = existingFileId;
      if (ctx.hashFn) ulOpts.hashFn = ctx.hashFn;
      const result = await retryWithBackoff(() => uploadFile(api, meta, localPath, relPath, rootDirId, ulOpts));
      meta.recordSync(relPath, {
        fileId: result.fileId,
        cloudMtime: result.cloudMtime,
        localMtime: Math.floor(Date.now() / 1000),
        contentHash: uploadHash,
        action: 'upload',
        direction: 'push',
      });
      stats.uploaded++;
      stats.changedPaths.push(localPath);
      stats.uploadedPaths.add(relPath);
      break;
    }

    case 'conflict': {
      if (cloudFile) {
        const merged = await tryDiff3Merge(relPath, localPath, cloudFile, ctx);
        if (merged) {
          stats.merged++;
          break;
        }
      }

      // Fallback: backup local + download cloud
      backupFile(localPath);
      if (cloudFile) {
        const conflictDlOpts: { cloudMtime?: number; hashFn?: (data: Uint8Array, path: string) => ContentHash | null } = {
          cloudMtime: cloudFile.mtime,
        };
        if (ctx.hashFn) conflictDlOpts.hashFn = ctx.hashFn;
        const result = await retryWithBackoff(() => downloadFile(api, cloudFile.id, localPath, conflictDlOpts));
        meta.recordSync(relPath, {
          fileId: cloudFile.id,
          cloudMtime: cloudFile.mtime,
          localMtime: Math.floor(Date.now() / 1000),
          parentId: cloudFile.parentId,
          domain: cloudFile.domain,
          contentHash: result.contentHash,
          action: 'conflict-download',
          direction: 'pull',
        });
      }
      stats.conflicts++;
      break;
    }

    case 'move': {
      if (state.kind !== 'moved') return;
      const oldPath = state.oldPath;
      const oldRecord = meta.getFileInfo(oldPath);
      const oldFileId = oldRecord?.fileId;

      if (oldFileId && cloudFile) {
        // Try cloud move API (preserves file_id and history)
        try {
          const newParentId = await ensureParentDir(api, meta, relPath, rootDirId);
          await retryWithBackoff(() => api.moveFile(oldFileId, newParentId, cloudFile.domain));

          const oldName = basename(oldPath);
          const newName = basename(relPath);
          if (oldName !== newName) {
            await retryWithBackoff(() => api.renameFile(oldFileId, newName, cloudFile.domain));
          }
        } catch {
          stats.failedMoves.push({
            oldPath: oldPath,
            newPath: relPath,
            fileId: oldFileId,
            domain: cloudFile.domain,
          });
        }
      }

      meta.renamePath(oldPath, relPath);

      if (oldFileId) {
        const localAbsPath = join(localDir, relPath);
        const localMtime = existsSync(localAbsPath)
          ? Math.floor(statSync(localAbsPath).mtimeMs / 1000)
          : 0;
        meta.recordSync(relPath, {
          fileId: oldFileId,
          cloudMtime: Math.floor(Date.now() / 1000),
          localMtime,
          action: 'moved',
          direction: 'pull',
        });
      }

      stats.moved++;
      break;
    }
  }
}

/**
 * Attempt a diff3 three-way merge for .md/.txt conflict files.
 *
 * Needs: base content (from metadata file_base), local content, cloud content.
 * If merge succeeds without conflicts, writes merged result locally and uploads.
 * Returns true if merge was performed, false to fall back to backup+download.
 */
async function tryDiff3Merge(
  relPath: string,
  localPath: string,
  cloudFile: CloudFile,
  ctx: ExecuteContext,
): Promise<boolean> {
  const ext = extname(relPath).toLowerCase();
  if (!MERGEABLE_EXTS.has(ext)) return false;
  if (!existsSync(localPath)) return false;

  const { api, meta, rootDirId, localDir } = ctx;

  // Try git history first, then file_base table (matches Python _try_diff3_merge)
  let baseBytes: Buffer | null = getFileContentFromGit(localDir, relPath);
  if (!baseBytes) {
    const baseRecord = meta.getBaseContent(relPath);
    if (!baseRecord) return false;
    baseBytes = baseRecord.content;
  }

  let theirs: string;
  try {
    const rawData = await api.getFileById(cloudFile.id as FileId);
    theirs = Buffer.from(rawData).toString('utf-8');
  } catch {
    return false;
  }

  const base = baseBytes.toString('utf-8');
  const ours = readFileSync(localPath, 'utf-8');

  const result = threeWayMerge(base, ours, theirs);
  if (result.hasConflicts) return false;

  backupFile(localPath);
  writeFileSync(localPath, result.mergedText, 'utf-8');

  const contentHash = ctx.hashFn
    ? ctx.hashFn(new TextEncoder().encode(result.mergedText), localPath)
    : null;

  if (contentHash) {
    meta.saveBaseContent(relPath, Buffer.from(result.mergedText, 'utf-8'), contentHash);
  }

  try {
    const ulOpts: { existingFileId?: FileId; hashFn?: (data: Uint8Array, path: string) => ContentHash | null } = {
      existingFileId: cloudFile.id as FileId,
    };
    if (ctx.hashFn) ulOpts.hashFn = ctx.hashFn;
    const ulResult = await uploadFile(api, meta, localPath, relPath, rootDirId, ulOpts);
    meta.recordSync(relPath, {
      fileId: ulResult.fileId,
      cloudMtime: ulResult.cloudMtime,
      localMtime: Math.floor(Date.now() / 1000),
      contentHash,
      action: 'merge-upload',
      direction: 'push',
    });
  } catch {
    return false;
  }

  return true;
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
