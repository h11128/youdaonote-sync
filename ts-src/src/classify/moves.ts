import { basename, dirname } from 'node:path';
import type { ContentHash, FileId } from '../types/common.js';
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
  'readme.md', 'index.md', 'index.html', 'todo.md', 'notes.md',
  'changelog.md', 'license.md', 'config.json', 'package.json',
  '.gitignore', 'makefile', 'dockerfile',
]);

/**
 * Three-phase move detection (matches Python moves.py):
 *
 * Phase 1: file_id matching — metadata file_id → cloud ID lookup
 * Phase 2: Filename normalization — same dir, sanitized names match
 * Phase 3: Cross-directory — content hash + filename + common ancestor depth
 *
 * Pure hash matching (the old approach) is subsumed by phase 3.
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
      case 'cloudDeleted': cloudDeletedPaths.add(path); break;
      case 'cloudNew': cloudNewPaths.add(path); break;
      case 'localDeleted': localDeletedPaths.add(path); break;
      case 'localNew': localNewPaths.add(path); break;
    }
  }

  // Phase 1: file_id matching
  if (meta && cloudSnap) {
    detectByFileId(
      localNewPaths, cloudNewPaths, cloudDeletedPaths,
      classified, meta, cloudSnap, result,
    );
  }

  // Phase 2: Filename normalization (same directory)
  detectByNormalizedName(
    cloudDeletedPaths, cloudNewPaths,
    localDeletedPaths, localNewPaths,
    result,
  );

  // Phase 3: Cross-directory matching (hash + filename + ancestor depth)
  detectCrossDirectory(
    cloudDeletedPaths, cloudNewPaths,
    localDeletedPaths, localNewPaths,
    classified, meta, result,
  );

  return result;
}

/**
 * Phase 1: For each "only local" file that has a file_id in metadata,
 * check if that file_id appears in the cloud snapshot at a different path.
 * If the cloud path is in cloudNew, this is a cloud-side rename.
 */
function detectByFileId(
  localNewPaths: Set<string>,
  cloudNewPaths: Set<string>,
  cloudDeletedPaths: Set<string>,
  classified: ReadonlyMap<string, ClassifiedEntry>,
  meta: MetadataStore,
  cloudSnap: ReadonlyMap<string, CloudFile>,
  result: Map<string, FileState>,
): void {
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

    result.set(cloudNewPath, { kind: 'moved', oldPath: localPath });
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

    result.set(localPath, { kind: 'moved', oldPath: cloudPath });
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
function detectByNormalizedName(
  cloudDeletedPaths: Set<string>,
  cloudNewPaths: Set<string>,
  localDeletedPaths: Set<string>,
  localNewPaths: Set<string>,
  result: Map<string, FileState>,
): void {
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
    const key = dirname(np) + '/' + sanitizeFilename(basename(np)).toLowerCase();
    normIndex.set(key, np);
  }

  for (const dp of [...deletedPaths]) {
    const key = dirname(dp) + '/' + sanitizeFilename(basename(dp)).toLowerCase();
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
function detectCrossDirectory(
  cloudDeletedPaths: Set<string>,
  cloudNewPaths: Set<string>,
  localDeletedPaths: Set<string>,
  localNewPaths: Set<string>,
  classified: ReadonlyMap<string, ClassifiedEntry>,
  meta: MetadataStore | undefined,
  result: Map<string, FileState>,
): void {
  crossDirMatch(cloudDeletedPaths, cloudNewPaths, classified, meta, result);
  crossDirMatch(localDeletedPaths, localNewPaths, classified, meta, result);
}

function crossDirMatch(
  deletedPaths: Set<string>,
  newPaths: Set<string>,
  classified: ReadonlyMap<string, ClassifiedEntry>,
  meta: MetadataStore | undefined,
  result: Map<string, FileState>,
): void {
  if (deletedPaths.size === 0 || newPaths.size === 0) return;

  // Step A: Hash matching
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
      const oldPath = dps[i]!;
      const newPath = nps[i]!;
      result.set(newPath, { kind: 'moved', oldPath });
      result.set(oldPath, { kind: 'gone' });
      deletedPaths.delete(oldPath);
      newPaths.delete(newPath);
    }
  }

  // Step B: Filename matching with ancestor depth
  if (deletedPaths.size === 0 || newPaths.size === 0) return;

  const MAX_NAME_CANDIDATES = 10;
  const newByName = new Map<string, string[]>();
  for (const np of newPaths) {
    const norm = sanitizeFilename(basename(np)).toLowerCase();
    pushToMap(newByName, norm as ContentHash, np);
  }

  for (const dp of [...deletedPaths]) {
    const norm = sanitizeFilename(basename(dp)).toLowerCase();
    if (GENERIC_NAMES.has(norm)) continue;
    const candidates = newByName.get(norm);
    if (!candidates || candidates.length > MAX_NAME_CANDIDATES) continue;

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

    if (bestPath && bestDepth >= 1) {
      const dpHash = classified.get(dp)?.hash;
      const bpHash = classified.get(bestPath)?.hash;
      if (dpHash && bpHash && dpHash !== bpHash) {
        // Content differs — only pair if the cloud file was previously synced (has file_id),
        // indicating "moved + edited" rather than two unrelated files with the same name.
        const dpMeta = meta?.getFileInfo(dp);
        if (!dpMeta?.fileId) continue;
      }
      result.set(bestPath, { kind: 'moved', oldPath: dp });
      result.set(dp, { kind: 'gone' });
      deletedPaths.delete(dp);
      newPaths.delete(bestPath);
    }
  }
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
