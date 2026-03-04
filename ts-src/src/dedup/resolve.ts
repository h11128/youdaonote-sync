import { basename, join } from 'node:path';
import { statSync } from 'node:fs';
import type { MetadataStore } from '../metadata/store.js';
import type { DedupAction, DedupStats } from './types.js';
import { isAsset } from './types.js';

/**
 * Collision protection: verify files with same hash also have same size.
 * Hash collisions with different sizes are dropped.
 */
export function classifyDuplicates(
  rawGroups: Map<string, string[]>,
  root: string,
  stats: DedupStats,
): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const [hash, paths] of rawGroups) {
    const bySize = new Map<number, string[]>();
    for (const p of paths) {
      try {
        const sz = statSync(join(root, p)).size;
        let list = bySize.get(sz);
        if (!list) { list = []; bySize.set(sz, list); }
        list.push(p);
      } catch {
        stats.skipped++;
      }
    }

    for (const [sz, subPaths] of bySize) {
      if (subPaths.length > 1) {
        result.set(`${hash}_${sz}`, subPaths);
      } else if (bySize.size > 1) {
        stats.skipped++;
      }
    }
  }

  return result;
}

/**
 * Score a cloud file for keep/delete decisions.
 * Tuple comparison: (depth, -nameLength, -ctime) — higher = more likely to keep.
 */
function cloudScore(path: string, meta: MetadataStore, root: string): [number, number, number] {
  const depth = path.split('/').length - 1;
  const nameClean = -basename(path).length;

  let ctime = 0;
  const info = meta.getFileInfo(path);
  if (info) {
    ctime = info.createTime || 0;
    if (ctime === 0) ctime = info.cloudMtime || info.localMtime || 0;
  }
  if (ctime === 0) {
    try { ctime = Math.floor(statSync(join(root, path)).mtimeMs / 1000); } catch { /* */ }
  }

  return [depth, nameClean, -ctime];
}

function compareScores(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (b[i]! !== a[i]!) return b[i]! - a[i]!;
  }
  return 0;
}

/**
 * Decide which files to keep and which to delete in a duplicate group.
 *
 * Case A: mixed (cloud + local) → delete local orphans
 * Case B: all-cloud → keep best-scored, delete rest
 * Case C: all-local → don't touch
 */
export function resolveGroup(
  paths: string[],
  meta: MetadataStore,
  referenced: Set<string>,
  root: string,
  stats: DedupStats,
): DedupAction[] {
  const cloudPaths: string[] = [];
  const localPaths: string[] = [];

  for (const p of paths) {
    if (meta.getFileInfo(p)?.fileId) cloudPaths.push(p);
    else localPaths.push(p);
  }

  if (cloudPaths.length > 0 && localPaths.length > 0) {
    return resolveMixed(cloudPaths, localPaths, referenced, stats);
  }

  if (cloudPaths.length > 1) {
    return resolveAllCloud(cloudPaths, meta, referenced, root, stats);
  }

  stats.skipped++;
  return [];
}

function resolveMixed(
  cloudPaths: string[],
  localPaths: string[],
  referenced: Set<string>,
  stats: DedupStats,
): DedupAction[] {
  const toRemove = localPaths.filter(lp => {
    if (isAsset(lp) && referenced.has(lp)) { stats.protectedRefs++; return false; }
    return true;
  });

  if (toRemove.length === 0) { stats.skipped++; return []; }

  const keep = cloudPaths[0]!;
  stats.kept += cloudPaths.length;
  stats.deleted += toRemove.length;
  return toRemove.map(r => ({
    removePath: r, cloudFileId: null, keepPath: keep, reason: `cloud version at ${keep}`,
  }));
}

function resolveAllCloud(
  cloudPaths: string[],
  meta: MetadataStore,
  referenced: Set<string>,
  root: string,
  stats: DedupStats,
): DedupAction[] {
  const [keepPaths, removePaths] = resolveCloudGroup(cloudPaths, meta, referenced, root, stats);
  if (!removePaths) return [];

  const actions: DedupAction[] = [];
  for (const r of removePaths) {
    const fid = meta.getFileInfo(r)?.fileId ?? null;
    actions.push({ removePath: r, cloudFileId: fid, keepPath: keepPaths[0]!, reason: `keep ${keepPaths[0]!}, delete cloud duplicate` });
  }

  stats.kept += keepPaths.length;
  stats.deleted += removePaths.length;
  stats.cloudDeleted += removePaths.length;
  return actions;
}

/**
 * All-cloud group resolution with asset-aware logic (matches Python _resolve_cloud_group).
 *
 * When any path is an asset:
 * - If both referenced and unreferenced exist → keep all referenced, remove all unreferenced
 * - If none are referenced → sort by score, keep best, remove rest
 * - If all are referenced → skip the group
 */
function resolveCloudGroup(
  cloudPaths: string[],
  meta: MetadataStore,
  referenced: Set<string>,
  root: string,
  stats: DedupStats,
): [string[], string[] | null] {
  if (cloudPaths.some(p => isAsset(p))) {
    const ref = cloudPaths.filter(p => referenced.has(p));
    const unref = cloudPaths.filter(p => !referenced.has(p));
    if (ref.length > 0 && unref.length > 0) {
      return [ref, unref];
    } else if (ref.length === 0) {
      const sorted = [...cloudPaths].sort((a, b) =>
        compareScores(cloudScore(a, meta, root), cloudScore(b, meta, root)));
      return [[sorted[0]!], sorted.slice(1)];
    } else {
      stats.skipped++;
      return [cloudPaths, null];
    }
  }

  const sorted = [...cloudPaths].sort((a, b) =>
    compareScores(cloudScore(a, meta, root), cloudScore(b, meta, root)));
  return [[sorted[0]!], sorted.slice(1)];
}
