import { basename, dirname } from 'node:path';
import {
  asRelPath,
  joinRelPath,
  type ContentHash,
  type FileId,
  type RelPath,
} from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { MetadataStore } from '../metadata/store.js';
import type { FileState } from '../types/state.js';
import { sanitizeFilename } from '../util/path.js';
import { crossDirMatch, type CrossDirMatchContext } from './cross-dir-match.js';

interface ClassifiedEntry {
  readonly state: FileState;
  readonly hash: ContentHash | null;
}

export interface PendingMove {
  fileId: FileId;
  oldCloudPath: RelPath;
  newLocalPath: RelPath;
  domain: number;
}

interface MoveDetectionContext {
  cloudDeletedPaths: Set<RelPath>;
  cloudNewPaths: Set<RelPath>;
  localDeletedPaths: Set<RelPath>;
  localNewPaths: Set<RelPath>;
  classified: ReadonlyMap<RelPath, ClassifiedEntry>;
  meta: MetadataStore | undefined;
  cloudSnap?: ReadonlyMap<RelPath, CloudFile>;
  result: Map<RelPath, FileState>;
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
  classified: ReadonlyMap<RelPath, ClassifiedEntry>,
  meta?: MetadataStore,
  cloudSnap?: ReadonlyMap<RelPath, CloudFile>,
): Map<RelPath, FileState> {
  const result = new Map<RelPath, FileState>();

  const cloudDeletedPaths = new Set<RelPath>();
  const cloudNewPaths = new Set<RelPath>();
  const localDeletedPaths = new Set<RelPath>();
  const localNewPaths = new Set<RelPath>();

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
  cloudSnap: ReadonlyMap<RelPath, CloudFile>,
): void {
  const { localNewPaths, cloudNewPaths, cloudDeletedPaths, meta, result } = ctx;
  if (!meta) return;

  const cloudIdToPath = new Map<string, RelPath>();
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

    const localPathRaw = meta.findByFileId(record.fileId);
    if (!localPathRaw || !localNewPaths.has(asRelPath(localPathRaw))) continue;

    const localRelPath = asRelPath(localPathRaw);
    result.set(localRelPath, { kind: 'moved', oldPath: cloudPath });
    result.set(cloudPath, { kind: 'gone' });
    cloudDeletedPaths.delete(cloudPath);
    localNewPaths.delete(localRelPath);
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
  deletedPaths: Set<RelPath>,
  newPaths: Set<RelPath>,
  result: Map<RelPath, FileState>,
): void {
  const normIndex = new Map<RelPath, RelPath>();
  for (const np of newPaths) {
    const parent = dirname(np);
    const key = parent
      ? joinRelPath(asRelPath(parent), sanitizeFilename(basename(np)))
      : asRelPath(sanitizeFilename(basename(np)));
    normIndex.set(key, np);
  }

  for (const dp of [...deletedPaths]) {
    const parent = dirname(dp);
    const key = parent
      ? joinRelPath(asRelPath(parent), sanitizeFilename(basename(dp)))
      : asRelPath(sanitizeFilename(basename(dp)));
    const match = normIndex.get(key);
    if (!match || !newPaths.has(match)) continue;

    result.set(match, { kind: 'moved', oldPath: dp });
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
  const toCrossCtx = (
    deletedPaths: Set<RelPath>,
    newPaths: Set<RelPath>,
  ): CrossDirMatchContext => ({
    deletedPaths,
    newPaths,
    classified,
    meta,
    result,
  });
  crossDirMatch(toCrossCtx(cloudDeletedPaths, cloudNewPaths));
  crossDirMatch(toCrossCtx(localDeletedPaths, localNewPaths));
}

function detectCrossSide(ctx: MoveDetectionContext): void {
  const { cloudNewPaths, localNewPaths, classified, meta, result } = ctx;
  if (cloudNewPaths.size === 0 || localNewPaths.size === 0) return;
  crossDirMatch({ deletedPaths: cloudNewPaths, newPaths: localNewPaths, classified, meta, result });
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
