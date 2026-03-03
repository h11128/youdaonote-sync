/**
 * Content-level deduplication (matches Python dedup.py).
 *
 * Two types of duplicates:
 * 1. Cloud vs Local: same content has cloud version (file_id) + local orphan → delete local
 * 2. Cloud self-duplication: same content has multiple cloud versions → keep best, delete rest
 *
 * Local-only duplicates are not touched.
 * Assets referenced by .md files are protected from deletion.
 */
import { basename, dirname, extname, join, relative } from 'node:path';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import type { ContentHash, FileId } from './types/common.js';
import type { MetadataRecord } from './types/metadata.js';
import type { MetadataStore } from './metadata/store.js';

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

interface FileDeleter {
  deleteFile(fileId: FileId): Promise<unknown>;
}

const ASSET_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico',
  '.pdf', '.amr', '.mp3', '.mp4', '.wav',
]);

const MD_REF_RE = /!\[[^\]]*\]\(([^)]+)\)|src="([^"]+)"/g;

function isAsset(path: string): boolean {
  return ASSET_EXTS.has(extname(path).toLowerCase());
}

/**
 * Extract image/resource references from all .md files under root.
 */
export function buildRefIndex(root: string, localFiles?: Map<string, { path: string; isDir: boolean }>): Set<string> {
  const referenced = new Set<string>();

  if (localFiles) {
    for (const [rel, info] of localFiles) {
      if (info.isDir || !rel.endsWith('.md')) continue;
      extractRefs(info.path, dirname(info.path), root, referenced);
    }
  } else {
    walkForRefs(root, root, referenced);
  }

  return referenced;
}

function walkForRefs(dir: string, root: string, referenced: Set<string>): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkForRefs(full, root, referenced);
    } else if (ent.name.endsWith('.md')) {
      extractRefs(full, dir, root, referenced);
    }
  }
}

function extractRefs(fullPath: string, mdDir: string, root: string, referenced: Set<string>): void {
  let content: string;
  try { content = readFileSync(fullPath, 'utf-8'); } catch { return; }

  for (const m of content.matchAll(MD_REF_RE)) {
    const refPath = m[1] ?? m[2];
    if (!refPath) continue;
    if (/^(https?:|data:|note:|ftp:|mailto:|\/\/)/.test(refPath)) continue;

    const abs = join(mdDir, refPath);
    const rel = relative(root, abs).replace(/\\/g, '/');
    referenced.add(rel);
  }
}

/**
 * Build a hash → paths index from metadata.
 */
export function buildHashIndex(meta: MetadataStore): Map<ContentHash, string[]> {
  const allFiles = meta.getAllFiles();
  const index = new Map<ContentHash, string[]>();

  for (const [path, record] of allFiles) {
    if (!record.contentHash) continue;
    const list = index.get(record.contentHash) ?? [];
    list.push(path);
    index.set(record.contentHash, list);
  }

  return index;
}

/**
 * Collision protection: verify files with same hash also have same size.
 * Returns groups that pass the check.
 */
function classifyDuplicates(
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
        const list = bySize.get(sz) ?? [];
        list.push(p);
        bySize.set(sz, list);
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
 * Higher score = more likely to keep.
 * (depth, -nameLength, -ctime)
 */
function cloudScore(
  path: string,
  meta: MetadataStore,
  root: string,
): [number, number, number] {
  const depth = path.split('/').length - 1;
  const nameClean = -basename(path).length;

  let ctime = 0;
  const info = meta.getFileInfo(path);
  if (info) {
    ctime = info.cloudMtime || info.localMtime || 0;
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

interface DedupAction {
  removePath: string;
  cloudFileId: FileId | null;
  keepPath: string;
  reason: string;
}

function resolveGroup(
  paths: string[],
  meta: MetadataStore,
  referenced: Set<string>,
  root: string,
  stats: DedupStats,
): DedupAction[] {
  const cloudPaths: string[] = [];
  const localPaths: string[] = [];

  for (const p of paths) {
    const info = meta.getFileInfo(p);
    if (info?.fileId) {
      cloudPaths.push(p);
    } else {
      localPaths.push(p);
    }
  }

  const actions: DedupAction[] = [];

  // Case A: mixed group (cloud + local) → delete local orphans
  if (cloudPaths.length > 0 && localPaths.length > 0) {
    const toRemove: string[] = [];
    for (const lp of localPaths) {
      if (isAsset(lp) && referenced.has(lp)) {
        stats.protectedRefs++;
        continue;
      }
      toRemove.push(lp);
    }
    if (toRemove.length === 0) {
      stats.skipped++;
      return actions;
    }
    const keep = cloudPaths[0]!;
    for (const r of toRemove) {
      actions.push({ removePath: r, cloudFileId: null, keepPath: keep, reason: `cloud version at ${keep}` });
    }
    stats.kept += cloudPaths.length;
    stats.deleted += toRemove.length;
    return actions;
  }

  // Case B: all-cloud group → keep best, delete rest
  if (cloudPaths.length > 1 && localPaths.length === 0) {
    const sorted = [...cloudPaths].sort((a, b) =>
      compareScores(cloudScore(a, meta, root), cloudScore(b, meta, root)));
    const keep = sorted[0]!;
    const toRemove = sorted.slice(1);

    for (const r of toRemove) {
      if (isAsset(r) && referenced.has(r)) {
        stats.protectedRefs++;
        continue;
      }
      const info = meta.getFileInfo(r);
      const fid = info?.fileId ?? null;
      actions.push({ removePath: r, cloudFileId: fid, keepPath: keep, reason: `keep ${keep}, delete cloud duplicate` });
    }
    stats.kept++;
    stats.deleted += toRemove.length;
    stats.cloudDeleted += toRemove.length;
    return actions;
  }

  // Case C: all-local → don't touch
  stats.skipped++;
  return actions;
}

function removeEmptyParents(filePath: string, root: string): void {
  let parent = dirname(filePath);
  const absRoot = join(root); // normalize
  while (parent !== absRoot && parent !== dirname(parent)) {
    try {
      const entries = readdirSync(parent);
      if (entries.length === 0) {
        rmSync(parent);
        parent = dirname(parent);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/**
 * Execute dedup removals. Returns list of deleted absolute paths.
 */
async function executeRemovals(
  actions: DedupAction[],
  root: string,
  meta: MetadataStore,
  api: FileDeleter | null,
  dryRun: boolean,
  stats: DedupStats,
): Promise<string[]> {
  const deleted: string[] = [];

  for (const { removePath, cloudFileId, keepPath, reason } of actions) {
    if (dryRun) {
      continue;
    }

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
      try {
        await api.deleteFile(cloudFileId);
      } catch {
        stats.cloudDeleted--;
      }
    }
  }

  return deleted;
}

/**
 * Full auto-dedup (matches Python auto_dedup).
 *
 * A) Mixed groups (cloud + local): delete local orphans
 * B) All-cloud groups: keep highest-scored, delete rest (local + cloud)
 * C) All-local: skip
 * Empty files: skip
 */
export async function autoDedup(
  root: string,
  meta: MetadataStore,
  opts?: {
    api?: FileDeleter;
    dryRun?: boolean;
  },
): Promise<DedupStats> {
  const stats = emptyDedupStats();
  const api = opts?.api ?? null;
  const dryRun = opts?.dryRun ?? false;

  const hashIndex = buildHashIndex(meta);
  const referenced = buildRefIndex(root);

  const rawDups = new Map<ContentHash, string[]>();
  for (const [hash, paths] of hashIndex) {
    if (paths.length > 1) rawDups.set(hash, paths);
  }

  if (rawDups.size === 0) return stats;

  const dupGroups = classifyDuplicates(rawDups, root, stats);

  const allActions: DedupAction[] = [];
  const sortedKeys = [...dupGroups.keys()].sort();

  for (const key of sortedKeys) {
    const paths = dupGroups.get(key)!;
    stats.groups++;

    try {
      const sz = statSync(join(root, paths[0]!)).size;
      if (sz === 0) {
        stats.skipped++;
        continue;
      }
    } catch {
      stats.skipped++;
      continue;
    }

    allActions.push(...resolveGroup(paths, meta, referenced, root, stats));
  }

  if (allActions.length === 0) return stats;

  await executeRemovals(allActions, root, meta, api, dryRun, stats);

  if (!dryRun) meta.save();

  return stats;
}

/**
 * Simple duplicate finder (backward compat).
 * Returns hash → duplicate paths (excludes the "keeper").
 */
export function findDuplicates(meta: MetadataStore): Map<ContentHash, string[]> {
  const allFiles = meta.getAllFiles();
  const byHash = new Map<ContentHash, Array<{ path: string; syncAt: number }>>();

  for (const [path, record] of allFiles) {
    if (!record.contentHash) continue;
    const list = byHash.get(record.contentHash) ?? [];
    list.push({ path, syncAt: record.lastSyncAt });
    byHash.set(record.contentHash, list);
  }

  const duplicates = new Map<ContentHash, string[]>();
  for (const [hash, entries] of byHash) {
    if (entries.length <= 1) continue;

    entries.sort((a, b) => b.syncAt - a.syncAt);
    const dupPaths = entries.slice(1).map((e) => e.path);
    duplicates.set(hash, dupPaths);
  }

  return duplicates;
}

/**
 * Remove duplicate files from metadata (backward compat, metadata-only).
 */
export function removeDuplicateMetadata(meta: MetadataStore): { total: number; duplicates: number; deleted: number } {
  const duplicates = findDuplicates(meta);
  let deleted = 0;
  let totalDups = 0;

  for (const paths of duplicates.values()) {
    totalDups += paths.length;
    for (const path of paths) {
      meta.removeFileInfo(path);
      deleted++;
    }
  }

  return {
    total: meta.getAllFiles().size + deleted,
    duplicates: totalDups,
    deleted,
  };
}
