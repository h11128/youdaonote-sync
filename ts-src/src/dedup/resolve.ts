import { basename, join } from 'node:path';
import { statSync } from 'node:fs';
import type { ContentHash, RelPath } from '../types/common.js';
import type { MetadataStore } from '../metadata/store.js';
import type { DedupAction, DedupStats } from './types.js';
import { isAsset } from './types.js';

/**
 * Collision protection: verify files with same hash also have same size.
 * Hash collisions with different sizes are dropped.
 */
function groupBySize(paths: RelPath[], root: string, stats: DedupStats): Map<number, RelPath[]> {
  const bySize = new Map<number, RelPath[]>();
  for (const p of paths) {
    try {
      const sz = statSync(join(root, p)).size;
      let list = bySize.get(sz);
      if (!list) {
        list = [];
        bySize.set(sz, list);
      }
      list.push(p);
    } catch {
      stats.skipped++;
    }
  }
  return bySize;
}

export function classifyDuplicates(
  rawGroups: Map<ContentHash, RelPath[]>,
  root: string,
  stats: DedupStats,
): Map<string, RelPath[]> {
  const result = new Map<string, RelPath[]>();

  for (const [hash, paths] of rawGroups) {
    const bySize = groupBySize(paths, root, stats);
    if (bySize.size > 1) {
      console.warn(
        `[dedup] hash collision: ${hash} has ${bySize.size} different sizes — possible hash collision`,
      );
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
function cloudScore(path: RelPath, meta: MetadataStore, root: string): [number, number, number] {
  const depth = path.split('/').length - 1;
  const nameClean = -basename(path).length;

  let ctime = 0;
  const info = meta.getFileInfo(path);
  if (info) {
    ctime = info.createTime || 0;
    if (ctime === 0) ctime = info.cloudMtime || info.localMtime || 0;
  }
  if (ctime === 0) {
    try {
      ctime = Math.floor(statSync(join(root, path)).mtimeMs / 1000);
    } catch {
      /* */
    }
  }

  return [depth, nameClean, -ctime];
}

function compareScores(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function splitCloudAndLocal(
  paths: RelPath[],
  meta: MetadataStore,
): { cloudPaths: RelPath[]; localPaths: RelPath[] } {
  const cloudPaths: RelPath[] = [];
  const localPaths: RelPath[] = [];
  for (const p of paths) {
    if (meta.getFileInfo(p)?.fileId) cloudPaths.push(p);
    else localPaths.push(p);
  }
  return { cloudPaths, localPaths };
}

export interface ResolveGroupOpts {
  paths: RelPath[];
  meta: MetadataStore;
  referenced: Set<RelPath>;
  root: string;
  stats: DedupStats;
}

/**
 * Decide which files to keep and which to delete in a duplicate group.
 *
 * Case A: mixed (cloud + local) → delete local orphans
 * Case B: all-cloud → keep best-scored, delete rest
 * Case C: all-local → don't touch
 */
export function resolveGroup(opts: ResolveGroupOpts): DedupAction[] {
  const { paths, meta, referenced, stats } = opts;
  const { cloudPaths, localPaths } = splitCloudAndLocal(paths, meta);

  if (cloudPaths.length > 0 && localPaths.length > 0) {
    return resolveMixed(cloudPaths, localPaths, referenced, stats);
  }

  if (cloudPaths.length > 1) {
    return resolveAllCloud({
      cloudPaths,
      meta: opts.meta,
      referenced: opts.referenced,
      root: opts.root,
      stats: opts.stats,
    });
  }
  stats.skipped++;
  return [];
}

function resolveMixed(
  cloudPaths: RelPath[],
  localPaths: RelPath[],
  referenced: Set<RelPath>,
  stats: DedupStats,
): DedupAction[] {
  const toRemove = localPaths.filter((lp) => {
    if (isAsset(lp) && referenced.has(lp)) {
      stats.protectedRefs++;
      return false;
    }
    return true;
  });

  if (toRemove.length === 0) {
    stats.skipped++;
    return [];
  }

  const keep = cloudPaths[0];
  if (!keep) return [];
  stats.kept += cloudPaths.length;
  stats.deleted += toRemove.length;
  return toRemove.map((r) => ({
    removePath: r,
    cloudFileId: null,
    keepPath: keep,
    reason: `cloud version at ${keep}`,
  }));
}

interface ResolveAllCloudOpts {
  cloudPaths: RelPath[];
  meta: MetadataStore;
  referenced: Set<RelPath>;
  root: string;
  stats: DedupStats;
}

function resolveAllCloud(opts: ResolveAllCloudOpts): DedupAction[] {
  const { meta, stats } = opts;
  const [keepPaths, removePaths] = resolveCloudGroup(opts);
  if (!removePaths) return [];

  const keepPath = keepPaths[0];
  if (!keepPath) return [];

  const actions: DedupAction[] = [];
  for (const r of removePaths) {
    const fid = meta.getFileInfo(r)?.fileId ?? null;
    actions.push({
      removePath: r,
      cloudFileId: fid,
      keepPath,
      reason: `keep ${keepPath}, delete cloud duplicate`,
    });
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
function resolveCloudGroup(opts: ResolveAllCloudOpts): [RelPath[], RelPath[] | null] {
  const { meta, stats } = opts;
  if (opts.cloudPaths.some((p) => isAsset(p))) {
    const ref = opts.cloudPaths.filter((p) => opts.referenced.has(p));
    const unref = opts.cloudPaths.filter((p) => !opts.referenced.has(p));
    if (ref.length > 0 && unref.length > 0) {
      return [ref, unref];
    } else if (ref.length === 0) {
      const sorted = [...opts.cloudPaths].sort((a, b) =>
        compareScores(cloudScore(a, meta, opts.root), cloudScore(b, meta, opts.root)),
      );
      const best = sorted[0];
      return best ? [[best], sorted.slice(1)] : [opts.cloudPaths, null];
    } else {
      stats.skipped++;
      return [opts.cloudPaths, null];
    }
  }

  const sorted = [...opts.cloudPaths].sort((a, b) =>
    compareScores(cloudScore(a, meta, opts.root), cloudScore(b, meta, opts.root)),
  );
  const best = sorted[0];
  return best ? [[best], sorted.slice(1)] : [opts.cloudPaths, null];
}
