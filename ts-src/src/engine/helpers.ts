import { extname } from 'node:path';
import type { MetadataStore } from '../metadata/store.js';
import type { ContentHash, EpochSeconds, RelPath } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { FileState, SyncAction } from '../types/state.js';
import { stateToAction } from '../types/state.js';
import { patternToRegex } from '../scan/local.js';
import { compileFilter } from '../scan/name.js';

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

export function matchesExclude(path: string, exclude?: string[]): boolean {
  if (!exclude?.length) return false;
  const excludeRes = exclude.map(patternToRegex);
  return excludeRes.some((re) => re.test(path));
}

interface PathFilterOpts {
  include?: string[];
  exclude?: string[];
}

function hasPathFilters(opts?: PathFilterOpts): boolean {
  return (opts?.include?.length ?? 0) > 0 || (opts?.exclude?.length ?? 0) > 0;
}

function pathAllowed(path: string, opts?: PathFilterOpts): boolean {
  if (!hasPathFilters(opts)) return true;
  return compileFilter(opts?.include ?? [], opts?.exclude ?? [])(path);
}

/** Drop paths that fail sync include/exclude (same rules as cloud/local scan). */
export function filterMapByExclude<T>(
  source: ReadonlyMap<RelPath, T>,
  opts?: PathFilterOpts | string[],
): ReadonlyMap<RelPath, T> {
  const normalized = normalizeFilterOpts(opts);
  if (!hasPathFilters(normalized)) return source;
  const out = new Map<RelPath, T>();
  for (const [path, value] of source) {
    if (pathAllowed(path, normalized)) out.set(path, value);
  }
  return out;
}

function normalizeFilterOpts(opts?: PathFilterOpts | string[]): PathFilterOpts | undefined {
  if (!opts) return undefined;
  if (Array.isArray(opts)) return { exclude: opts };
  return opts;
}

/** Force excluded paths to `gone` so execute never downloads/uploads them. */
export function markExcludedAsGone(
  classified: Map<RelPath, FileState>,
  opts?: PathFilterOpts | string[],
): void {
  const normalized = normalizeFilterOpts(opts);
  if (!hasPathFilters(normalized)) return;
  for (const path of [...classified.keys()]) {
    if (!pathAllowed(path, normalized)) classified.set(path, { kind: 'gone' });
  }
}

/** Remove metadata rows for excluded paths — prevents stale entries from re-entering classify. */
export function purgeExcludedMetadata(
  meta: MetadataStore,
  opts?: PathFilterOpts | string[],
): number {
  const normalized = normalizeFilterOpts(opts);
  if (!hasPathFilters(normalized)) return 0;
  const toRemove: RelPath[] = [];
  for (const path of meta.getAllFiles().keys()) {
    if (!pathAllowed(path, normalized)) toRemove.push(path);
  }
  if (toRemove.length === 0) return 0;
  meta.batch(() => {
    for (const path of toRemove) meta.removeFileInfo(path);
  });
  return toRemove.length;
}

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
 * Path is an active sync *file* (not a directory) in cloud and/or local snaps.
 */
export function isActiveSyncFile(
  path: RelPath,
  cloudSnap: ReadonlyMap<RelPath, CloudFile>,
  localSnap: ReadonlyMap<RelPath, LocalFile>,
): boolean {
  const cloud = cloudSnap.get(path);
  const local = localSnap.get(path);
  const inCloudAsFile = cloud !== undefined && !cloud.isDir;
  const inLocalAsFile = local !== undefined && !local.isDir;
  return inCloudAsFile || inLocalAsFile;
}

/**
 * After a *full* cloud scan, drop `files` rows that are not active sync files.
 *
 * Active = present in cloudSnap as a file OR localSnap as a file.
 * Directories belong in `dirs`; artifact paths (`images/`, `.note` leftovers)
 * are absent from snaps — remove them instead of leaving empty `file_id` zombies
 * (clearCloudId-only left 2500+ perpetual empty rows).
 *
 * Critical: keep rows still in localSnap as files (just-uploaded may be missing
 * from pre-execute cloudSnap).
 */
export function listInactiveFilePaths(
  meta: MetadataStore,
  cloudSnap: ReadonlyMap<RelPath, CloudFile>,
  localSnap: ReadonlyMap<RelPath, LocalFile>,
): RelPath[] {
  const toRemove: RelPath[] = [];
  for (const path of meta.getAllFiles().keys()) {
    if (!isActiveSyncFile(path, cloudSnap, localSnap)) toRemove.push(path);
  }
  return toRemove;
}

export function cleanupStalePaths(
  meta: MetadataStore,
  cloudSnap: ReadonlyMap<RelPath, CloudFile>,
  localSnap: ReadonlyMap<RelPath, LocalFile>,
): number {
  const toRemove = listInactiveFilePaths(meta, cloudSnap, localSnap);
  if (toRemove.length === 0) return 0;
  meta.batch(() => {
    for (const path of toRemove) {
      meta.removeFileInfo(path);
    }
  });
  return toRemove.length;
}
