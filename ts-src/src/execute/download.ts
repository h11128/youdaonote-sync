import {
  writeFileSync,
  mkdirSync,
  utimesSync,
  renameSync,
  unlinkSync,
  readFileSync,
} from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { YoudaoNoteApi } from '../api/client.js';
import { NoteDomain } from '../types/common.js';
import {
  asEpochSeconds,
  type ContentHash,
  type EpochSeconds,
  type FileId,
  type RelPath,
} from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { xmlBytesToMarkdown } from '../convert/xml-to-md.js';
import { jsonBytesToMarkdown } from '../convert/json-to-md.js';
import { htmlBytesToMarkdown } from '../convert/html-to-md.js';
import { requireNonEmpty } from '../util/preconditions.js';

import { readFileMtime } from '../util/utils.js';
import { migrateImages } from './images.js';
import type { ExecuteContext, SyncStats } from './types.js';

export type FileType = 'markdown' | 'xml' | 'json' | 'html' | 'binary';

/**
 * Detect the content type of a downloaded note by inspecting the first bytes.
 */
export function detectFileType(data: Uint8Array, ext: string): FileType {
  const prefix = Buffer.from(data.slice(0, 50)).toString('utf-8').trimStart();
  if (prefix.startsWith('<?xml')) return 'xml';
  if (prefix.startsWith('{"')) return 'json';
  if (/^<!DOCTYPE\s+html/i.test(prefix) || /^<html/i.test(prefix)) return 'html';
  if (ext === '.md') return 'markdown';
  return 'binary';
}

/**
 * Convert raw note bytes to Markdown based on detected type.
 * Returns the Markdown string, or null if the file is binary.
 */
export function convertToMarkdown(data: Uint8Array, fileType: FileType): string | null {
  switch (fileType) {
    case 'markdown':
      return Buffer.from(data).toString('utf-8');
    case 'xml':
      return xmlBytesToMarkdown(data);
    case 'json':
      return jsonBytesToMarkdown(data);
    case 'html':
      return htmlBytesToMarkdown(data);
    case 'binary':
      return null;
  }
}

export interface DownloadResult {
  readonly localPath: string;
  readonly fileType: FileType;
  /** Hash of the content written to disk (after conversion). */
  readonly contentHash: ContentHash | null;
  /** Hash of the raw API response bytes (before conversion). */
  readonly rawContentHash: ContentHash | null;
  readonly rawData: Uint8Array;
}

/**
 * Download a single file from the cloud and save it locally.
 *
 * Steps:
 * 1. Download raw bytes via API
 * 2. Detect content type (markdown/xml/json/binary)
 * 3. Convert to markdown if needed
 * 4. Write to local path
 * 5. Set file modification time
 */
export async function downloadFile(
  api: YoudaoNoteApi,
  fileId: FileId,
  localPath: string,
  opts?: {
    cloudMtime?: number;
    hashFn?: (data: Uint8Array, path: string) => ContentHash | null;
  },
): Promise<DownloadResult> {
  requireNonEmpty('fileId', fileId);
  requireNonEmpty('localPath', localPath);
  const rawData = await api.getFileById(fileId);
  const data = new Uint8Array(rawData);

  const ext = extname(localPath).toLowerCase();
  const fileType = detectFileType(data, ext);
  const markdown = convertToMarkdown(data, fileType);
  assertNoRawStructuredContent(ext, markdown, fileType);

  const dir = dirname(localPath);
  mkdirSync(dir, { recursive: true });

  // Atomic write: tmp file → rename, so interrupted downloads don't leave partial files
  const tmpPath = join(dir, `.dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    if (markdown !== null) {
      writeFileSync(tmpPath, markdown, 'utf-8');
    } else {
      writeFileSync(tmpPath, data);
    }
    renameSync(tmpPath, localPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* cleanup best-effort */
    }
    throw err;
  }

  if (opts?.cloudMtime && opts.cloudMtime > 0) {
    try {
      const mtime = opts.cloudMtime;
      utimesSync(localPath, mtime, mtime);
    } catch {
      /* ignore timing errors */
    }
  }

  const contentBytes = markdown !== null ? new TextEncoder().encode(markdown) : data;
  const contentHash = opts?.hashFn?.(contentBytes, localPath) ?? null;
  const rawContentHash = opts?.hashFn?.(data, localPath) ?? null;

  return { localPath, fileType, contentHash, rawContentHash, rawData: data };
}

/**
 * Sanity check: a .md file should never contain raw structured data.
 * If detectFileType correctly identified JSON/XML/HTML, conversion should have
 * produced markdown text. If we still see raw structured content targeting a .md
 * path, something went wrong in the detection/conversion pipeline.
 */
/** @internal Exported for testing only. */
export function assertNoRawStructuredContent(
  ext: string,
  converted: string | null,
  fileType: FileType,
): void {
  if (ext !== '.md' || converted === null) return;
  const prefix = converted.slice(0, 50).trimStart();
  if (prefix.startsWith('{"') || prefix.startsWith('<?xml')) {
    throw new Error(
      `Download sanity check failed: .md file contains raw ${prefix.startsWith('{"') ? 'JSON' : 'XML'} ` +
        `after conversion (fileType=${fileType}). This indicates a bug in detectFileType or convertToMarkdown.`,
    );
  }
}

async function tryMigrateImages(localPath: string, api: YoudaoNoteApi): Promise<void> {
  try {
    const dir = dirname(localPath);
    await migrateImages(localPath, join(dir, 'images'), join(dir, 'attachments'), {
      Cookie: api.getCookieHeader(),
    });
  } catch {
    /* best-effort */
  }
}

export async function handleDownload(o: {
  relPath: RelPath;
  localPath: string;
  cloudFile: CloudFile;
  ctx: ExecuteContext;
  stats: SyncStats;
}): Promise<void> {
  const { relPath, localPath, cloudFile, ctx, stats } = o;
  const { api, meta } = ctx;
  const dlOpts: {
    cloudMtime?: EpochSeconds;
    hashFn?: (data: Uint8Array, path: string) => ContentHash | null;
  } = { cloudMtime: cloudFile.mtime };
  if (ctx.hashFn) dlOpts.hashFn = ctx.hashFn;
  const result = await downloadFile(api, cloudFile.id as FileId, localPath, dlOpts);
  meta.recordSync(relPath, {
    fileId: cloudFile.id as FileId,
    cloudMtime: cloudFile.mtime,
    localMtime: asEpochSeconds(readFileMtime(localPath, cloudFile.mtime)),
    parentId: cloudFile.parentId,
    domain: cloudFile.domain,
    contentHash: result.contentHash,
    cloudContentHash: result.rawContentHash,
    action: 'download',
    direction: 'pull',
  });
  if (cloudFile.domain === NoteDomain.NOTE && result.contentHash) {
    const mdContent = readFileSync(localPath);
    meta.saveBaseContent(relPath, mdContent, result.contentHash);
  }
  await tryMigrateImages(localPath, api);
  stats.downloaded++;
  stats.changedPaths.push(localPath);
}
