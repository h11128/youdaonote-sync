import { dirname, join, resolve } from 'node:path';
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import type { ContentHash, EpochSeconds, FileId, RelPath } from '../types/common.js';
import type { MetadataStore } from '../metadata/store.js';
import type { DedupAction, DedupStats, FileDeleter } from './types.js';
import { emptyDedupStats } from './types.js';
import { buildHashIndex, type BuildIndexOpts } from './hash-index.js';
import { buildRefIndex } from './refs.js';
import { classifyDuplicates, resolveGroup } from './resolve.js';
import { logger } from '../util/logger.js';

function removeEmptyParents(filePath: string, root: string): void {
  let parent = dirname(filePath);
  const absRoot = resolve(root);
  while (parent !== absRoot && parent !== dirname(parent)) {
    try {
      if (readdirSync(parent).length === 0) {
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

interface ExecuteRemovalsOpts {
  actions: DedupAction[];
  root: string;
  meta: MetadataStore;
  api: FileDeleter | null;
  dryRun: boolean;
  stats: DedupStats;
}

function handleDryRunAction(
  removePath: RelPath,
  cloudFileId: string | undefined,
  reason: string,
): void {
  const cloudTag = cloudFileId ? ' + 云端' : '';
  logger.info(`[去重] 删除${cloudTag} ${removePath}`);
  logger.info(`       ${reason}`);
}

interface LocalRemovalResult {
  ok: true;
  fullPath: string;
  didDelete: boolean;
}

interface ProcessLocalRemovalOpts {
  root: string;
  removePath: RelPath;
  cloudFileId: string | null;
  meta: MetadataStore;
  stats: DedupStats;
}

function processLocalRemoval(opts: ProcessLocalRemovalOpts): LocalRemovalResult | null {
  const { root, removePath, cloudFileId, meta, stats } = opts;
  const full = join(root, removePath);
  try {
    meta.removeFileInfo(removePath);
    if (existsSync(full)) {
      unlinkSync(full);
      removeEmptyParents(full, root);
      return { ok: true, fullPath: full, didDelete: true };
    }
  } catch {
    stats.deleted--;
    if (cloudFileId) stats.cloudDeleted--;
    return null;
  }
  return { ok: true, fullPath: full, didDelete: false };
}

async function deleteCloudFile(
  cloudFileId: FileId,
  api: FileDeleter,
  stats: DedupStats,
): Promise<void> {
  try {
    await api.deleteFile(cloudFileId);
  } catch {
    stats.cloudDeleted--;
  }
}

interface ExecuteSingleRemovalCtx {
  root: string;
  meta: MetadataStore;
  api: FileDeleter | null;
  stats: DedupStats;
}

async function executeSingleRemoval(
  action: DedupAction,
  ctx: ExecuteSingleRemovalCtx,
): Promise<string | null> {
  const { root, meta, api, stats } = ctx;
  const result = processLocalRemoval({
    root,
    removePath: action.removePath,
    cloudFileId: action.cloudFileId,
    meta,
    stats,
  });
  if (!result) return null;

  if (action.cloudFileId && api) {
    await deleteCloudFile(action.cloudFileId, api, stats);
  }
  return result.didDelete ? result.fullPath : null;
}

async function executeRemovals(opts: ExecuteRemovalsOpts): Promise<string[]> {
  const { actions, root, meta, api, dryRun, stats } = opts;
  const deleted: string[] = [];
  const ctx: ExecuteSingleRemovalCtx = { root, meta, api, stats };

  for (const action of actions) {
    if (dryRun) {
      handleDryRunAction(action.removePath, action.cloudFileId ?? undefined, action.reason);
      continue;
    }
    const delPath = await executeSingleRemoval(action, ctx);
    if (delPath) deleted.push(delPath);
  }

  return deleted;
}

function buildRawDuplicates(hashIndex: Map<ContentHash, RelPath[]>): Map<ContentHash, RelPath[]> {
  const rawDups = new Map<ContentHash, RelPath[]>();
  for (const [hash, paths] of hashIndex) {
    if (paths.length > 1) rawDups.set(hash, paths);
  }
  return rawDups;
}

function shouldSkipEmptyFile(root: string, firstPath: RelPath): boolean {
  try {
    return statSync(join(root, firstPath)).size === 0;
  } catch {
    return true;
  }
}

interface CollectDedupActionsInput {
  dupGroups: Map<string, RelPath[]>;
  root: string;
  meta: MetadataStore;
  referenced: Set<RelPath>;
  stats: DedupStats;
}

function collectDedupActions(input: CollectDedupActionsInput): DedupAction[] {
  const { dupGroups, root, meta, referenced, stats } = input;
  const allActions: DedupAction[] = [];
  for (const key of [...dupGroups.keys()].sort()) {
    const paths = dupGroups.get(key);
    if (!paths || paths.length === 0) continue;
    stats.groups++;
    const firstPath = paths[0];
    if (!firstPath || shouldSkipEmptyFile(root, firstPath)) {
      stats.skipped++;
      continue;
    }
    allActions.push(...resolveGroup({ paths, meta, referenced, root, stats }));
  }
  return allActions;
}

interface AutoDedupOpts {
  api?: FileDeleter;
  dryRun?: boolean;
  hashCache?: Map<string, ContentHash>;
  localFiles?: Map<RelPath, { path: string; mtime: EpochSeconds; isDir: boolean }>;
}

function runAutoDedupPipeline(
  root: string,
  meta: MetadataStore,
  opts: AutoDedupOpts,
): Promise<DedupResult> {
  const stats = emptyDedupStats();
  const indexOpts: BuildIndexOpts = { hashCache: opts.hashCache, localFiles: opts.localFiles };
  const hashIndex = buildHashIndex(root, meta, indexOpts);
  const referenced = buildRefIndex(root, opts.localFiles, meta);
  const rawDups = buildRawDuplicates(hashIndex);

  if (rawDups.size === 0) return Promise.resolve({ stats, deletedPaths: [] });

  const dupGroups = classifyDuplicates(rawDups, root, stats);
  const allActions = collectDedupActions({
    dupGroups,
    root,
    meta,
    referenced,
    stats,
  });

  if (allActions.length === 0) return Promise.resolve({ stats, deletedPaths: [] });

  return executeRemovals({
    actions: allActions,
    root,
    meta,
    api: opts.api ?? null,
    dryRun: opts.dryRun ?? false,
    stats,
  }).then((deletedPaths) => {
    if (!opts.dryRun) meta.save();
    return { stats, deletedPaths };
  });
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
  opts?: AutoDedupOpts,
): Promise<DedupResult> {
  if (!root || typeof root !== 'string') {
    throw new Error('autoDedup: root must be a non-empty string');
  }
  return runAutoDedupPipeline(root, meta, opts ?? {});
}

export interface DedupResult {
  stats: DedupStats;
  deletedPaths: string[];
}
