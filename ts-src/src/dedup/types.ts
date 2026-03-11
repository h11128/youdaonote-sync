import { extname } from 'node:path';
import type { FileId, RelPath } from '../types/common.js';

export interface DedupStats {
  groups: number;
  deleted: number;
  cloudDeleted: number;
  kept: number;
  skipped: number;
  protectedRefs: number;
}

export function emptyDedupStats(): DedupStats {
  return { groups: 0, deleted: 0, cloudDeleted: 0, kept: 0, skipped: 0, protectedRefs: 0 };
}

export interface FileDeleter {
  deleteFile(fileId: FileId): Promise<unknown>;
}

export interface DedupAction {
  removePath: RelPath;
  cloudFileId: FileId | null;
  keepPath: RelPath;
  reason: string;
}

export const ASSET_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.svg',
  '.ico',
  '.pdf',
  '.amr',
  '.mp3',
  '.mp4',
  '.wav',
]);

export function isAsset(path: RelPath): boolean {
  return ASSET_EXTS.has(extname(path).toLowerCase());
}
