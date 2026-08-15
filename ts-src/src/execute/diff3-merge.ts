import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import type { YoudaoNoteApi } from '../api/client.js';
import type { MetadataStore } from '../metadata/store.js';
import {
  asContentHash,
  asEpochSeconds,
  type ContentHash,
  type DirId,
  type FileId,
  type RelPath,
} from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { applyCloudUploadTarget } from './resolve-upload-target.js';
import { uploadFile, type UploadFileOpts } from './upload.js';
import { detectFileType, convertToMarkdown } from './download.js';
import { threeWayMerge } from '../algo/merge.js';
import { isUnusableContentHash } from '../algo/content-hash.js';
import { getFileContentFromGit } from '../util/git.js';
import { readFileMtime } from '../util/utils.js';
import { logger } from '../util/logger.js';
import type { SyncLogMetadata } from '../types/state.js';

const MERGEABLE_EXTS = new Set(['.md', '.txt']);

export type MergeResult = 'merged' | 'deferred' | false;

function hashMergedText(
  hashFn: ((data: Uint8Array, path: string) => ContentHash | null) | undefined,
  text: string,
  localPath: string,
): ContentHash | null {
  if (!hashFn) return null;
  const h = hashFn(new TextEncoder().encode(text), localPath);
  return isUnusableContentHash(h) ? null : h;
}

export interface Diff3Context {
  api: YoudaoNoteApi;
  meta: MetadataStore;
  rootDirId: DirId;
  localDir: string;
  hashFn?: (data: Uint8Array, path: string) => ContentHash | null;
  logMeta?: SyncLogMetadata;
}

async function fetchCloudMarkdown(
  api: YoudaoNoteApi,
  fileId: FileId,
  ext: string,
): Promise<string | null> {
  try {
    const rawData = await api.getFileById(fileId);
    const data = new Uint8Array(rawData);
    const fileType = detectFileType(data, ext);
    return convertToMarkdown(data, fileType);
  } catch {
    return null;
  }
}

function decodeBase(baseBytes: Buffer, ext: string): string {
  let base = baseBytes.toString('utf-8');
  const baseFileType = detectFileType(new Uint8Array(baseBytes), ext);
  if (baseFileType !== 'markdown' && baseFileType !== 'binary') {
    const converted = convertToMarkdown(new Uint8Array(baseBytes), baseFileType);
    if (converted !== null) base = converted;
  }
  return base;
}

/**
 * Attempt a diff3 three-way merge for .md/.txt conflict files.
 * Returns 'merged' if merge+upload succeeded, 'deferred' if merge succeeded
 * but upload failed (local file updated, will retry next cycle), or false
 * to fall back to backup+download.
 */
export async function tryDiff3Merge(
  relPath: RelPath,
  localPath: string,
  cloudFile: CloudFile,
  ctx: Diff3Context,
): Promise<MergeResult> {
  const ext = extname(relPath).toLowerCase();
  if (!MERGEABLE_EXTS.has(ext) || !existsSync(localPath)) return false;
  const { meta, localDir, logMeta } = ctx;

  const baseRecord = meta.getBaseContent(relPath);
  const baseBytes = baseRecord?.content ?? getFileContentFromGit(localDir, relPath);
  if (!baseBytes) return false;

  const theirs = await fetchCloudMarkdown(ctx.api, cloudFile.id as FileId, ext);
  if (theirs === null) return false;

  const base = decodeBase(baseBytes, ext);
  const ours = readFileSync(localPath, 'utf-8');
  const result = threeWayMerge(base, ours, theirs);
  if (result.hasConflicts) return false;

  writeFileSync(localPath, result.mergedText, 'utf-8');
  const contentHash = hashMergedText(ctx.hashFn, result.mergedText, localPath);
  if (contentHash)
    meta.saveBaseContent(relPath, Buffer.from(result.mergedText, 'utf-8'), contentHash);

  const prevHash = baseRecord?.hash
    ? asContentHash(baseRecord.hash)
    : (meta.getFileInfo(relPath)?.contentHash ?? null);
  return uploadMergedFile({
    relPath,
    localPath,
    cloudFile,
    ctx,
    contentHash,
    prevHash,
    ...(logMeta !== undefined ? { logMeta } : {}),
  });
}

async function uploadMergedFile(opts: {
  relPath: RelPath;
  localPath: string;
  cloudFile: CloudFile;
  ctx: Diff3Context;
  contentHash: ContentHash | null;
  prevHash: ContentHash | null;
  logMeta?: SyncLogMetadata | undefined;
}): Promise<MergeResult> {
  const { relPath, localPath, cloudFile, ctx, contentHash, prevHash, logMeta } = opts;
  const { api, meta, rootDirId } = ctx;
  try {
    const ulOpts: UploadFileOpts = {
      api,
      meta,
      localPath,
      relPath,
      rootDirId,
    };
    applyCloudUploadTarget(ulOpts, cloudFile);
    if (ctx.hashFn) ulOpts.hashFn = ctx.hashFn;
    const ulResult = await uploadFile(ulOpts);
    meta.recordSync(relPath, {
      fileId: ulResult.fileId,
      cloudMtime: ulResult.cloudMtime,
      localMtime: asEpochSeconds(readFileMtime(localPath)),
      contentHash,
      action: 'merge-upload',
      direction: 'push',
      ...logMeta,
      ...(ulResult.domain != null ? { domain: ulResult.domain } : {}),
    });
    return 'merged';
  } catch (e: unknown) {
    logger.warn(
      `[diff3] merge succeeded but upload failed for ${relPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    // Merge was clean — keep the merged local file. Record sync using the
    // *previous* content hash (from base record or metadata) so next cycle
    // sees localHashChanged=true (merged ≠ prev) + cloudMtimeChanged=false
    // → localModified → normal upload retry.
    meta.recordSync(relPath, {
      fileId: cloudFile.id as FileId,
      cloudMtime: cloudFile.mtime,
      localMtime: asEpochSeconds(readFileMtime(localPath)),
      contentHash: prevHash,
      action: 'merge-upload-deferred',
      direction: 'push',
      ...logMeta,
    });
    return 'deferred';
  }
}
