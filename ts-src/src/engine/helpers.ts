import { extname } from 'node:path';
import type { MetadataStore } from '../metadata/store.js';
import type { ContentHash, EpochSeconds, RelPath } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { FileState, SyncAction } from '../types/state.js';
import { stateToAction } from '../types/state.js';
import { patternToRegex } from '../scan/local.js';

const HASHABLE_EXTS = new Set([
  '.md',
  '.txt',
  '.html',
  '.htm',
  '.xml',
  '.json',
  '.css',
  '.js',
  '.csv',
]);

function isConflictCandidate(state: FileState): boolean {
  return state.kind === 'cloudModifiedContent' || state.kind === 'conflict';
}

function collectConflictCandidates(
  classified: Map<RelPath, FileState>,
  cloudSnap: ReadonlyMap<RelPath, CloudFile>,
): { relPath: RelPath; cloudFile: CloudFile }[] {
  const candidates: { relPath: RelPath; cloudFile: CloudFile }[] = [];
  for (const [relPath, state] of classified) {
    if (!isConflictCandidate(state)) continue;
    if (!HASHABLE_EXTS.has(extname(relPath).toLowerCase())) continue;
    const cf = cloudSnap.get(relPath);
    if (cf) candidates.push({ relPath, cloudFile: cf });
  }
  return candidates;
}

/**
 * Filter cloud snapshot by include/exclude patterns (matches local scan filtering).
 * Removes entries that don't match include patterns or that match exclude patterns.
 */
export function filterCloudSnap(
  cloudSnap: Map<RelPath, CloudFile>,
  opts: { include?: string[]; exclude?: string[] },
): void {
  const includeRes = (opts.include ?? []).map(patternToRegex);
  const excludeRes = (opts.exclude ?? []).map(patternToRegex);

  for (const path of [...cloudSnap.keys()]) {
    if (excludeRes.some((re) => re.test(path))) {
      cloudSnap.delete(path);
      continue;
    }
    if (includeRes.length > 0 && !includeRes.some((re) => re.test(path))) {
      cloudSnap.delete(path);
    }
  }
}

/**
 * Filter classified entries by sync direction.
 * 'pull' keeps only downloads/conflicts; 'push' keeps only uploads.
 * Non-matching entries are set to 'gone' (skipped).
 */
export function filterByDirection(
  classified: Map<RelPath, FileState>,
  direction: 'pull' | 'push',
): void {
  const allowedActions: Set<SyncAction> =
    direction === 'pull' ? new Set(['download', 'conflict']) : new Set(['upload']);

  for (const [path, state] of classified) {
    const action = stateToAction(state);
    if (action === 'skip' || action === 'move') continue;
    if (!allowedActions.has(action)) {
      classified.set(path, { kind: 'gone' });
    }
  }
}

export { collectConflictCandidates, HASHABLE_EXTS };

export function buildDedupInputs(
  localSnap: Map<RelPath, LocalFile>,
  localHashes: Map<RelPath, ContentHash | null>,
): {
  localFileMap: Map<RelPath, { path: string; mtime: EpochSeconds; isDir: boolean }>;
  absPathHashes: Map<string, ContentHash>;
} {
  const localFileMap = new Map<RelPath, { path: string; mtime: EpochSeconds; isDir: boolean }>();
  const absPathHashes = new Map<string, ContentHash>();
  for (const [rel, info] of localSnap) {
    localFileMap.set(rel, { path: info.path, mtime: info.mtime, isDir: info.isDir });
    const h = localHashes.get(rel);
    if (h) absPathHashes.set(info.path, h);
  }
  return { localFileMap, absPathHashes };
}

export function applyRefinementIfChanged(
  relPath: RelPath,
  refined: FileState,
  classified: Map<RelPath, FileState>,
): void {
  const current = classified.get(relPath);
  if (current && refined.kind !== current.kind) {
    classified.set(relPath, refined);
  }
}

/**
 * Clean up metadata for files that no longer exist in cloud.
 * Clears the file_id so they won't be treated as cloud-linked.
 */
export function cleanupStalePaths(
  meta: MetadataStore,
  cloudSnap: ReadonlyMap<RelPath, CloudFile>,
): void {
  const activeCloudPaths = new Set<RelPath>();
  for (const [path, cf] of cloudSnap) {
    if (!cf.isDir) activeCloudPaths.add(path);
  }
  const stalePaths = meta.getStaleCloudPaths(activeCloudPaths);
  if (stalePaths.length === 0) return;
  meta.batch(() => {
    for (const path of stalePaths) {
      meta.clearCloudId(path);
    }
  });
}
