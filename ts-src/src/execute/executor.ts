import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FileState, SyncAction } from '../types/state.js';
import { stateToAction } from '../types/state.js';
import type { YoudaoNoteApi } from '../api/client.js';
import type { MetadataStore } from '../metadata/store.js';
import type { NoteDomain } from '../types/common.js';
import type { ContentHash, DirId, FileId, RelPath, SyncDirection } from '../types/common.js';
import { asEpochSeconds, joinRelPath } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { handleDownload } from './download.js';
import { uploadFile, ensureParentDir, type UploadFileOpts } from './upload.js';
import { conflictFallback, type ConflictOpts } from './conflict.js';
import { tryDiff3Merge } from './diff3-merge.js';
import { retryWithBackoff } from '../api/retry.js';
import { handleMove } from './move-handler.js';
import { pLimit } from '../util/concurrency.js';

export interface SyncStats {
  downloaded: number;
  uploaded: number;
  skipped: number;
  conflicts: number;
  errors: number;
  moved: number;
  merged: number;
  readonly changedPaths: string[];
  readonly failedMoves: { oldPath: RelPath; newPath: RelPath; fileId: FileId; domain: number }[];
  readonly uploadedPaths: Set<RelPath>;
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
    uploadedPaths: new Set<RelPath>(),
  };
}

function readFileMtime(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

export interface ExecuteContext {
  api: YoudaoNoteApi;
  meta: MetadataStore;
  rootDirId: DirId;
  localDir: string;
  hashFn?: (data: Uint8Array, path: string) => ContentHash | null;
  /** Per-session dedup map for concurrent directory creation. */
  dirCreateInflight?: Map<string, Promise<DirId>> | undefined;
  /** Local snapshot — used to detect directories when cloud entry is missing. */
  localSnap?: ReadonlyMap<RelPath, { isDir: boolean }> | undefined;
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
  classified: ReadonlyMap<RelPath, FileState>,
  cloud: ReadonlyMap<RelPath, CloudFile>,
  local: ReadonlyMap<RelPath, { isDir: boolean }> | undefined,
  stats: SyncStats,
): {
  dirEntries: [RelPath, FileState, SyncAction][];
  fileEntries: [RelPath, FileState, SyncAction][];
} {
  const dirEntries: [RelPath, FileState, SyncAction][] = [];
  const fileEntries: [RelPath, FileState, SyncAction][] = [];
  for (const [relPath, state] of classified) {
    const action = stateToAction(state);
    if (action === 'skip') {
      stats.skipped++;
      continue;
    }
    const isDir = cloud.get(relPath)?.isDir ?? local?.get(relPath)?.isDir ?? false;
    (isDir ? dirEntries : fileEntries).push([relPath, state, action]);
  }
  return { dirEntries, fileEntries };
}

function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function resolveUploadMeta(
  record: { fileId?: FileId; domain?: number } | undefined,
  cloudFile: CloudFile | undefined,
): { fileId?: FileId; domain?: number } | undefined {
  if (record != null) return record;
  const domain = cloudFile?.domain;
  return domain != null ? { domain } : undefined;
}

type Entry = [RelPath, FileState, SyncAction];

export async function executeAll(
  classified: ReadonlyMap<RelPath, FileState>,
  cloud: ReadonlyMap<RelPath, CloudFile>,
  ctx: ExecuteContext,
  direction: SyncDirection = 'both',
): Promise<SyncStats> {
  const stats = emptyStats();
  const ctxWithInflight = {
    ...ctx,
    dirCreateInflight: ctx.dirCreateInflight ?? new Map<string, Promise<DirId>>(),
  };
  const { dirEntries, fileEntries } = partitionEntries(classified, cloud, ctx.localSnap, stats);

  for (const [relPath, _state, action] of dirEntries) {
    try {
      await executeDir(relPath, action, ctxWithInflight, stats);
    } catch (e: unknown) {
      stats.errors++;
      console.error(`Error processing dir ${relPath}: ${formatError(e)}`);
    }
  }

  await runFileEntries(fileEntries, { cloud, ctx: ctxWithInflight, stats, direction });
  return Object.freeze(stats);
}

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

  const limit = pLimit(5);
  const run = async ([relPath, state, action]: Entry): Promise<void> => {
    try {
      await executeSingle({ relPath, state, action, cloud, ctx, stats, direction });
    } catch (e: unknown) {
      stats.errors++;
      console.error(`Error processing ${relPath}: ${formatError(e)}`);
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
async function executeDir(
  relPath: RelPath,
  action: SyncAction,
  ctx: ExecuteContext,
  stats: SyncStats,
): Promise<void> {
  if (action === 'download') {
    mkdirSync(join(ctx.localDir, relPath), { recursive: true });
    stats.downloaded++;
  } else if (action === 'upload') {
    await ensureParentDir({
      api: ctx.api,
      meta: ctx.meta,
      relPath: joinRelPath(relPath, '_placeholder'),
      rootDirId: ctx.rootDirId,
      inflight: ctx.dirCreateInflight,
    });
    stats.uploaded++;
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
}

async function handleUpload(o: {
  relPath: RelPath;
  localPath: string;
  metaRecord: { fileId?: FileId; domain?: number } | undefined;
  ctx: ExecuteContext;
  stats: SyncStats;
}): Promise<void> {
  const { relPath, localPath, metaRecord, ctx, stats } = o;
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
  if (metaRecord?.domain != null) ulOpts.existingDomain = metaRecord.domain as NoteDomain;
  if (ctx.hashFn) ulOpts.hashFn = ctx.hashFn;
  const result = await retryWithBackoff(() => uploadFile(ulOpts));
  meta.recordSync(relPath, {
    fileId: result.fileId,
    cloudMtime: result.cloudMtime,
    localMtime: asEpochSeconds(readFileMtime(localPath)),
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
  const localPath = join(localDir, relPath);
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
    upload: () => {
      const uploadMeta = resolveUploadMeta(metaRecord ?? undefined, cloudFile);
      return handleUpload({ relPath, localPath, metaRecord: uploadMeta, ctx, stats });
    },
    conflict: () => handleConflict({ relPath, localPath, cloudFile, ctx, stats, direction }),
    move: () => handleMove({ relPath, state, ctx, stats }),
    skip: () => Promise.resolve(),
  };
  const handler = handlers[action];
  await handler();
}
