/**
 * Remove files-table rows that can never be active sync files.
 * Runs on every sync (not only full cloud scan) to stop empty-file_id zombies
 * from images/, .note leftovers, and directories wrongly stored in `files`.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MetadataStore } from '../metadata/store.js';
import type { RelPath } from '../types/common.js';

const ARTIFACT_SEG = /(?:^|\/)(images|attachments)(?:\/|$)/i;

/** Paths that local/cloud scan never treat as sync files. */
export function isNonSyncableFilesTablePath(relPath: RelPath, localDir: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  if (ARTIFACT_SEG.test(norm)) return true;
  if (norm.endsWith('.note') || norm.endsWith('.clip')) return true;
  const full = join(localDir, relPath);
  try {
    if (existsSync(full) && statSync(full).isDirectory()) return true;
    // Deleted dir leftovers: no on-disk node and basename has no extension
    // (note files are almost always *.md / media.*). Full-scan cleanupStalePaths
    // still covers other inactive rows.
    const base = norm.split('/').pop() ?? '';
    if (!existsSync(full) && base.length > 0 && !base.includes('.')) return true;
  } catch {
    /* ignore inaccessible */
  }
  return false;
}

export function listNonSyncableFilePaths(meta: MetadataStore, localDir: string): RelPath[] {
  const out: RelPath[] = [];
  for (const path of meta.getAllFiles().keys()) {
    if (isNonSyncableFilesTablePath(path, localDir)) out.push(path);
  }
  return out;
}

export function purgeNonSyncableFileRows(meta: MetadataStore, localDir: string): number {
  const toRemove = listNonSyncableFilePaths(meta, localDir);
  if (toRemove.length === 0) return 0;
  meta.batch(() => {
    for (const path of toRemove) {
      meta.removeFileInfo(path);
    }
  });
  return toRemove.length;
}
