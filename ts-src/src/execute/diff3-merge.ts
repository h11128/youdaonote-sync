import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import type { YoudaoNoteApi } from '../api/client.js';
import type { MetadataStore } from '../metadata/store.js';
import {
  asEpochSeconds,
  type ContentHash,
  type DirId,
  type FileId,
  type RelPath,
} from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { uploadFile, type UploadFileOpts } from './upload.js';
import { backupFile } from './conflict.js';
import { threeWayMerge } from '../algo/merge.js';
import { getFileContentFromGit } from '../util/git.js';
import { readFileMtime } from '../util/utils.js';

const MERGEABLE_EXTS = new Set(['.md', '.txt']);

export interface Diff3Context {
  api: YoudaoNoteApi;
  meta: MetadataStore;
  rootDirId: DirId;
  localDir: string;
  hashFn?: (data: Uint8Array, path: string) => ContentHash | null;
}

/**
 * Attempt a diff3 three-way merge for .md/.txt conflict files.
 * Returns true if merge was performed, false to fall back to backup+download.
 */
export async function tryDiff3Merge(
  relPath: RelPath,
  localPath: string,
  cloudFile: CloudFile,
  ctx: Diff3Context,
): Promise<boolean> {
  const ext = extname(relPath).toLowerCase();
  if (!MERGEABLE_EXTS.has(ext) || !existsSync(localPath)) return false;
  const { api, meta, localDir } = ctx;

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
  if (contentHash)
    meta.saveBaseContent(relPath, Buffer.from(result.mergedText, 'utf-8'), contentHash);

  return uploadMergedFile({ relPath, localPath, cloudFile, ctx, contentHash });
}

async function uploadMergedFile(opts: {
  relPath: RelPath;
  localPath: string;
  cloudFile: CloudFile;
  ctx: Diff3Context;
  contentHash: ContentHash | null;
}): Promise<boolean> {
  const { relPath, localPath, cloudFile, ctx, contentHash } = opts;
  const { api, meta, rootDirId } = ctx;
  try {
    const ulOpts: UploadFileOpts = {
      api,
      meta,
      localPath,
      relPath,
      rootDirId,
      existingFileId: cloudFile.id as FileId,
    };
    if (ctx.hashFn) ulOpts.hashFn = ctx.hashFn;
    const ulResult = await uploadFile(ulOpts);
    meta.recordSync(relPath, {
      fileId: ulResult.fileId,
      cloudMtime: ulResult.cloudMtime,
      localMtime: asEpochSeconds(readFileMtime(localPath)),
      contentHash,
      action: 'merge-upload',
      direction: 'push',
    });
    return true;
  } catch {
    return false;
  }
}
