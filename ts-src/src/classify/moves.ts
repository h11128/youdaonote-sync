import { basename, dirname } from 'node:path';
import { asRelPath, type ContentHash, type FileId } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { MetadataStore } from '../metadata/store.js';
import type { FileState } from '../types/state.js';
import { sanitizeFilename } from '../util/path.js';

interface ClassifiedEntry {
  readonly state: FileState;
  readonly hash: ContentHash | null;
}

export interface PendingMove {
  fileId: FileId;
  oldCloudPath: string;
  newLocalPath: string;
  domain: number;
}

const GENERIC_NAMES = new Set([
  'readme.md',
  'index.md',
  'index.html',
  'todo.md',
  'notes.md',
  'changelog.md',
  'license.md',
  'config.json',
  'package.json',
  '.gitignore',
  'makefile',
  'dockerfile',
]);

interface MoveDetectionContext {
  cloudDeletedPaths: Set<string>;
  cloudNewPaths: Set<string>;
  localDeletedPaths: Set<string>;
  localNewPaths: Set<string>;
  classified: ReadonlyMap<string, ClassifiedEntry>;
  meta: MetadataStore | undefined;
  cloudSnap?: ReadonlyMap<string, CloudFile>;
  result: Map<string, FileState>;
}

/**
 * Four-phase move detection:
 *
 * Phase 1: file_id matching — metadata file_id → cloud ID lookup
 * Phase 2: Filename normalization — same dir, sanitized names match
 * Phase 3: Cross-directory — content hash + filename + common ancestor depth
 *          (same-side: cloudDeleted↔cloudNew, localDeleted↔localNew)
 * Phase 4: Cross-side — cloudNew↔localNew hash/filename matching
 *          (handles simultaneous rename on both sides)
 *
 * Hash source: localHash (from disk) with metadata contentHash as fallback
 * for paths where the local file no longer exists.
 */
export function detectMoves(
  classified: ReadonlyMap<string, ClassifiedEntry>,
  meta?: MetadataStore,
  cloudSnap?: ReadonlyMap<string, CloudFile>,
): Map<string, FileState> {
  const result = new Map<string, FileState>();

  const cloudDeletedPaths = new Set<string>();
  const cloudNewPaths = new Set<string>();
  const localDeletedPaths = new Set<string>();
  const localNewPaths = new Set<string>();

  for (const [path, entry] of classified) {
    switch (entry.state.kind) {
      case 'cloudDeleted':
        cloudDeletedPaths.add(path);
        break;
      case 'cloudNew':
        cloudNewPaths.add(path);
        break;
      case 'localDeleted':
        localDeletedPaths.add(path);
        break;
      case 'localNew':
        localNewPaths.add(path);
        break;
    }
  }

  const ctx: MoveDetectionContext = {
    cloudDeletedPaths,
    cloudNewPaths,
    localDeletedPaths,
    localNewPaths,
    classified,
    meta,
    ...(cloudSnap !== undefined ? { cloudSnap } : {}),
    result,
  };

  // Phase 1: file_id matching
  if (meta && cloudSnap) detectByFileId({ ...ctx, meta, cloudSnap }, cloudSnap);

  // Phase 2: Filename normalization (same directory)
  detectByNormalizedName(ctx);

  // Phase 3: Cross-directory matching (hash + filename + ancestor depth)
  detectCrossDirectory(ctx);

  // Phase 4: Cross-side matching (cloudNew ↔ localNew)
  // Handles the case where a file was moved/renamed on both sides simultaneously:
  // the original path disappears, and each side has a "new" path.
  detectCrossSide(ctx);

  return result;
}

/**
 * Phase 1: For each "only local" file that has a file_id in metadata,
 * check if that file_id appears in the cloud snapshot at a different path.
 * If the cloud path is in cloudNew, this is a cloud-side rename.
 */
function detectByFileId(
  ctx: MoveDetectionContext,
  cloudSnap: ReadonlyMap<string, CloudFile>,
): void {
  const { localNewPaths, cloudNewPaths, cloudDeletedPaths, meta, result } = ctx;
  if (!meta) return;

  const cloudIdToPath = new Map<string, string>();
  for (const [path, cf] of cloudSnap) {
    if (!cf.isDir && cf.id) cloudIdToPath.set(cf.id, path);
  }

  // Case A: local-only file has file_id → cloud moved it
  for (const localPath of [...localNewPaths]) {
    const record = meta.getFileInfo(localPath);
    if (!record?.fileId) continue;

    const cloudNewPath = cloudIdToPath.get(record.fileId);
    if (!cloudNewPath || !cloudNewPaths.has(cloudNewPath)) continue;

    result.set(cloudNewPath, { kind: 'moved', oldPath: asRelPath(localPath) });
    result.set(localPath, { kind: 'gone' });
    localNewPaths.delete(localPath);
    cloudNewPaths.delete(cloudNewPath);
  }

  // Case B: cloud-deleted file has file_id in metadata;
  // if that file_id now maps to a localNew path, this is a local-side move.
  for (const cloudPath of [...cloudDeletedPaths]) {
    const record = meta.getFileInfo(cloudPath);
    if (!record?.fileId) continue;

    const localPath = meta.findByFileId(record.fileId);
    if (!localPath || !localNewPaths.has(localPath)) continue;

    result.set(localPath, { kind: 'moved', oldPath: asRelPath(cloudPath) });
    result.set(cloudPath, { kind: 'gone' });
    cloudDeletedPaths.delete(cloudPath);
    localNewPaths.delete(localPath);
  }
}

/**
 * Phase 2: Same-directory filename normalization.
 * If `(dirname, sanitize(basename))` matches between a deleted and a new entry,
 * treat it as a rename caused by character sanitization differences.
 */
function detectByNormalizedName(ctx: MoveDetectionContext): void {
  const { cloudDeletedPaths, cloudNewPaths, localDeletedPaths, localNewPaths, result } = ctx;
  matchByNormalizedName(cloudDeletedPaths, cloudNewPaths, result);
  matchByNormalizedName(localDeletedPaths, localNewPaths, result);
}

function matchByNormalizedName(
  deletedPaths: Set<string>,
  newPaths: Set<string>,
  result: Map<string, FileState>,
): void {
  const normIndex = new Map<string, string>();
  for (const np of newPaths) {
    const key = dirname(np) + '/' + sanitizeFilename(basename(np));
    normIndex.set(key, np);
  }

  for (const dp of [...deletedPaths]) {
    const key = dirname(dp) + '/' + sanitizeFilename(basename(dp));
    const match = normIndex.get(key);
    if (!match || !newPaths.has(match)) continue;

    result.set(match, { kind: 'moved', oldPath: asRelPath(dp) });
    result.set(dp, { kind: 'gone' });
    deletedPaths.delete(dp);
    newPaths.delete(match);
    normIndex.delete(key);
  }
}

/**
 * Phase 3: Cross-directory matching.
 *
 * Step A: Hash match (strong signal) — same hash in deleted+new
 * Step B: Filename match (weak signal) — same normalized name + shared ancestor depth ≥1
 *         Skips GENERIC_NAMES to avoid false positives.
 */
function detectCrossDirectory(ctx: MoveDetectionContext): void {
  const {
    cloudDeletedPaths,
    cloudNewPaths,
    localDeletedPaths,
    localNewPaths,
    classified,
    meta,
    result,
  } = ctx;
  crossDirMatch({
    deletedPaths: cloudDeletedPaths,
    newPaths: cloudNewPaths,
    classified,
    meta,
    result,
  });
  crossDirMatch({
    deletedPaths: localDeletedPaths,
    newPaths: localNewPaths,
    classified,
    meta,
    result,
  });
}

function detectCrossSide(ctx: MoveDetectionContext): void {
  const { cloudNewPaths, localNewPaths, classified, meta, result } = ctx;
  if (cloudNewPaths.size === 0 || localNewPaths.size === 0) return;
  crossDirMatch({
    deletedPaths: cloudNewPaths,
    newPaths: localNewPaths,
    classified,
    meta,
    result,
  });
}

interface CrossDirMatchContext {
  deletedPaths: Set<string>;
  newPaths: Set<string>;
  classified: ReadonlyMap<string, ClassifiedEntry>;
  meta: MetadataStore | undefined;
  result: Map<string, FileState>;
}

function applyHashMatches(ctx: CrossDirMatchContext): void {
  const { deletedPaths, newPaths, classified, result } = ctx;

  const deletedByHash = new Map<ContentHash, string[]>();
  const newByHash = new Map<ContentHash, string[]>();

  for (const dp of deletedPaths) {
    const hash = classified.get(dp)?.hash;
    if (!hash) continue;
    pushToMap(deletedByHash, hash, dp);
  }
  for (const np of newPaths) {
    const hash = classified.get(np)?.hash;
    if (!hash) continue;
    pushToMap(newByHash, hash, np);
  }

  for (const [hash, dps] of deletedByHash) {
    const nps = newByHash.get(hash);
    if (!nps) continue;
    const pairCount = Math.min(dps.length, nps.length);
    for (let i = 0; i < pairCount; i++) {
      const oldPath = dps[i];
      const newPath = nps[i];
      if (oldPath === undefined || newPath === undefined) continue;
      result.set(newPath, { kind: 'moved', oldPath: asRelPath(oldPath) });
      result.set(oldPath, { kind: 'gone' });
      deletedPaths.delete(oldPath);
      newPaths.delete(newPath);
    }
  }
}

function findBestPathByName(
  dp: string,
  candidates: string[],
  result: Map<string, FileState>,
): string | null {
  let bestPath: string | null = null;
  let bestDepth = -1;
  for (const np of candidates) {
    if (result.has(np)) continue;
    const depth = commonAncestorDepth(dp, np);
    if (depth > bestDepth) {
      bestDepth = depth;
      bestPath = np;
    }
  }
  return bestDepth >= 1 ? bestPath : null;
}

function canPairDifferentContent(
  dp: string,
  bestPath: string,
  classified: ReadonlyMap<string, ClassifiedEntry>,
  meta: MetadataStore | undefined,
): boolean {
  const dpHash = classified.get(dp)?.hash;
  const bpHash = classified.get(bestPath)?.hash;
  if (!dpHash || !bpHash || dpHash === bpHash) return true;
  const dpMeta = meta?.getFileInfo(dp);
  return !!dpMeta?.fileId;
}

function applyFilenameMatches(ctx: CrossDirMatchContext): void {
  const { deletedPaths, newPaths, classified, meta, result } = ctx;
  const MAX_NAME_CANDIDATES = 10;

  const newByName = new Map<string, string[]>();
  for (const np of newPaths) {
    const norm = sanitizeFilename(basename(np)).toLowerCase();
    pushToMap(newByName, norm, np);
  }

  for (const dp of [...deletedPaths]) {
    const norm = sanitizeFilename(basename(dp)).toLowerCase();
    if (GENERIC_NAMES.has(norm)) continue;
    const candidates = newByName.get(norm);
    if (!candidates || candidates.length > MAX_NAME_CANDIDATES) continue;

    const bestPath = findBestPathByName(dp, candidates, result);
    if (!bestPath) continue;

    if (!canPairDifferentContent(dp, bestPath, classified, meta)) continue;

    result.set(bestPath, { kind: 'moved', oldPath: asRelPath(dp) });
    result.set(dp, { kind: 'gone' });
    deletedPaths.delete(dp);
    newPaths.delete(bestPath);
  }
}

function crossDirMatch(ctx: CrossDirMatchContext): void {
  const { deletedPaths, newPaths } = ctx;
  if (deletedPaths.size === 0 || newPaths.size === 0) return;

  applyHashMatches(ctx);
  if (deletedPaths.size === 0 || newPaths.size === 0) return;

  applyFilenameMatches(ctx);
}

function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

export function commonAncestorDepth(pathA: string, pathB: string): number {
  const partsA = pathA.replace(/\\/g, '/').split('/').slice(0, -1);
  const partsB = pathB.replace(/\\/g, '/').split('/').slice(0, -1);
  let depth = 0;
  for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
    if (partsA[i] === partsB[i]) depth++;
    else break;
  }
  return depth;
}
