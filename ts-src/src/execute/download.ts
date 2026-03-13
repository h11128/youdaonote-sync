import { writeFileSync, mkdirSync, utimesSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { YoudaoNoteApi } from '../api/client.js';
import type { FileId, ContentHash } from '../types/common.js';
import { xmlBytesToMarkdown } from '../convert/xml-to-md.js';
import { jsonBytesToMarkdown } from '../convert/json-to-md.js';
import { htmlBytesToMarkdown } from '../convert/html-to-md.js';
import { requireNonEmpty } from '../util/preconditions.js';

export type FileType = 'markdown' | 'xml' | 'json' | 'html' | 'binary';

/**
 * Detect the content type of a downloaded note by inspecting the first bytes.
 */
export function detectFileType(data: Uint8Array, ext: string): FileType {
  if (ext === '.md') return 'markdown';

  const prefix = Buffer.from(data.slice(0, 50)).toString('utf-8').trimStart();
  if (prefix.startsWith('<?xml')) return 'xml';
  if (prefix.startsWith('{"')) return 'json';
  if (/^<!DOCTYPE\s+html/i.test(prefix) || /^<html/i.test(prefix)) return 'html';
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
  readonly contentHash: ContentHash | null;
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

  return { localPath, fileType, contentHash, rawData: data };
}
