import { basename } from 'node:path';
import { asRelPath, type ContentHash, type RelPath } from '../types/common.js';
import type { MetadataStore } from '../metadata/store.js';
import type { FileState } from '../types/state.js';
import { sanitizeFilename, normalizeSep } from '../util/path.js';
import { commonAncestorDepth } from './moves.js';
import { collectDeletedMoveHashes, isUnusableMoveHash } from './move-hashes.js';

interface ClassifiedEntry {
  readonly state: FileState;
  readonly hash: ContentHash | null;
}

export interface CrossDirMatchContext {
  deletedPaths: Set<RelPath>;
  newPaths: Set<RelPath>;
  classified: ReadonlyMap<RelPath, ClassifiedEntry>;
  meta: MetadataStore | undefined;
  result: Map<RelPath, FileState>;
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

function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

function pairByHash(opts: {
  deletedByHash: Map<ContentHash, RelPath[]>;
  newByHash: Map<ContentHash, RelPath[]>;
  deletedPaths: Set<RelPath>;
  newPaths: Set<RelPath>;
  result: Map<RelPath, FileState>;
}): void {
  const { deletedByHash, newByHash, deletedPaths, newPaths, result } = opts;
  for (const [hash, dps] of deletedByHash) {
    const nps = newByHash.get(hash);
    if (!nps) continue;
    for (const oldPath of dps) {
      if (!deletedPaths.has(oldPath)) continue;
      const newPath = nps.find((np) => newPaths.has(np));
      if (newPath === undefined) continue;
      result.set(newPath, { kind: 'moved', oldPath: asRelPath(oldPath) });
      result.set(oldPath, { kind: 'gone' });
      deletedPaths.delete(oldPath);
      newPaths.delete(newPath);
    }
  }
}

function applyHashMatches(ctx: CrossDirMatchContext): void {
  const { deletedPaths, newPaths, classified, meta, result } = ctx;

  const deletedByHash = new Map<ContentHash, RelPath[]>();
  const newByHash = new Map<ContentHash, RelPath[]>();

  for (const dp of deletedPaths) {
    const primary = classified.get(dp)?.hash ?? null;
    for (const hash of collectDeletedMoveHashes(dp, primary, meta)) {
      pushToMap(deletedByHash, hash, dp);
    }
  }
  for (const np of newPaths) {
    const hash = classified.get(np)?.hash;
    if (!hash || isUnusableMoveHash(hash)) continue;
    pushToMap(newByHash, hash, np);
  }

  pairByHash({ deletedByHash, newByHash, deletedPaths, newPaths, result });
}

function isRootLevel(path: RelPath): boolean {
  return !normalizeSep(path).includes('/');
}

/**
 * Pick the best new-path candidate by shared ancestor depth.
 * Depth ≥ 1 is always accepted. Depth 0 is allowed only when a root-level
 * path is involved and the normalized name has exactly one unused candidate
 * (so root → subdir moves work without pairing unrelated dir-a ↔ dir-b names).
 */
function findBestPathByName(
  dp: RelPath,
  candidates: RelPath[],
  result: Map<RelPath, FileState>,
): RelPath | null {
  let bestPath: RelPath | null = null;
  let bestDepth = -1;
  let unusedCount = 0;
  for (const np of candidates) {
    if (result.has(np)) continue;
    unusedCount++;
    const depth = commonAncestorDepth(dp, np);
    if (depth > bestDepth) {
      bestDepth = depth;
      bestPath = np;
    }
  }
  if (!bestPath) return null;
  if (bestDepth >= 1) return bestPath;
  const rootInvolved = isRootLevel(dp) || isRootLevel(bestPath);
  return rootInvolved && unusedCount === 1 ? bestPath : null;
}

function canPairDifferentContent(
  dp: RelPath,
  bestPath: RelPath,
  classified: ReadonlyMap<RelPath, ClassifiedEntry>,
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

  const newByName = new Map<string, RelPath[]>();
  for (const np of newPaths) {
    const norm = sanitizeFilename(basename(np)).toLowerCase();
    pushToMap(newByName, norm, np);
  }

  for (const dp of [...deletedPaths]) {
    const norm = sanitizeFilename(basename(dp)).toLowerCase();
    if (GENERIC_NAMES.has(norm)) continue;
    const candidates = newByName.get(norm);
    if (!candidates || candidates.length > MAX_NAME_CANDIDATES) continue;

    const dpRel = asRelPath(dp);
    const bestPath = findBestPathByName(dpRel, candidates, result);
    if (!bestPath) continue;

    if (!canPairDifferentContent(dpRel, bestPath, classified, meta)) continue;

    result.set(bestPath, { kind: 'moved', oldPath: dpRel });
    result.set(dpRel, { kind: 'gone' });
    deletedPaths.delete(dp);
    newPaths.delete(bestPath);
  }
}

export function crossDirMatch(ctx: CrossDirMatchContext): void {
  const { deletedPaths, newPaths } = ctx;
  if (deletedPaths.size === 0 || newPaths.size === 0) return;

  applyHashMatches(ctx);
  if (deletedPaths.size === 0 || newPaths.size === 0) return;

  applyFilenameMatches(ctx);
}
