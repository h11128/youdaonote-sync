import { dirname, join } from 'node:path';
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import type { ContentHash } from '../types/common.js';
import type { MetadataStore } from '../metadata/store.js';
import type { DedupAction, DedupStats, FileDeleter } from './types.js';
import { emptyDedupStats } from './types.js';
import { buildHashIndex, type BuildIndexOpts } from './hash-index.js';
import { buildRefIndex } from './refs.js';
import { classifyDuplicates, resolveGroup } from './resolve.js';

function removeEmptyParents(filePath: string, root: string): void {
  let parent = dirname(filePath);
  const absRoot = join(root);
  while (parent !== absRoot && parent !== dirname(parent)) {
    try {
      if (readdirSync(parent).length === 0) {
        rmSync(parent);
        parent = dirname(parent);
      } else {
        break;
      }
    } catch { break; }
  }
}

async function executeRemovals(
  actions: DedupAction[],
  root: string,
  meta: MetadataStore,
  api: FileDeleter | null,
  dryRun: boolean,
  stats: DedupStats,
): Promise<string[]> {
  const deleted: string[] = [];

  for (const { removePath, cloudFileId } of actions) {
    if (dryRun) continue;

    const full = join(root, removePath);
    try {
      meta.removeFileInfo(removePath);
      if (existsSync(full)) {
        unlinkSync(full);
        deleted.push(full);
        removeEmptyParents(full, root);
      }
    } catch {
      stats.deleted--;
      if (cloudFileId) stats.cloudDeleted--;
      continue;
    }

    if (cloudFileId && api) {
      try { await api.deleteFile(cloudFileId); }
      catch { stats.cloudDeleted--; }
    }
  }

  return deleted;
}

/**
 * Full auto-dedup pipeline (matches Python auto_dedup).
 *
 * A) Mixed groups (cloud + local): delete local orphans
 * B) All-cloud groups: keep highest-scored, delete rest
 * C) All-local: skip
 */
export async function autoDedup(
  root: string,
  meta: MetadataStore,
  opts?: {
    api?: FileDeleter;
    dryRun?: boolean;
    hashCache?: Map<string, ContentHash>;
    localFiles?: Map<string, { path: string; mtime: number; isDir: boolean }>;
  },
): Promise<DedupResult> {
  const stats = emptyDedupStats();

  const indexOpts: BuildIndexOpts = {
    hashCache: opts?.hashCache,
    localFiles: opts?.localFiles,
  };
  const hashIndex = buildHashIndex(root, meta, indexOpts);
  const referenced = buildRefIndex(root, opts?.localFiles, meta);

  const rawDups = new Map<ContentHash, string[]>();
  for (const [hash, paths] of hashIndex) {
    if (paths.length > 1) rawDups.set(hash, paths);
  }
  if (rawDups.size === 0) return { stats, deletedPaths: [] };

  const dupGroups = classifyDuplicates(rawDups, root, stats);
  const allActions: DedupAction[] = [];

  for (const key of [...dupGroups.keys()].sort()) {
    const paths = dupGroups.get(key)!;
    stats.groups++;

    try {
      if (statSync(join(root, paths[0]!)).size === 0) { stats.skipped++; continue; }
    } catch { stats.skipped++; continue; }

    allActions.push(...resolveGroup(paths, meta, referenced, root, stats));
  }

  if (allActions.length === 0) return { stats, deletedPaths: [] };

  const deletedPaths = await executeRemovals(allActions, root, meta, opts?.api ?? null, opts?.dryRun ?? false, stats);
  if (!opts?.dryRun) meta.save();

  return { stats, deletedPaths };
}

export interface DedupResult {
  stats: DedupStats;
  deletedPaths: string[];
}
