import { xxh128 } from './xxhash.js';
import type { ContentHash, RelPath } from '../types/common.js';
import type { LocalFile } from '../types/scan.js';

export type TreeHash = string & { readonly __brand: 'TreeHash' };

export type HashFn = (data: string) => string;

const defaultHash: HashFn = (data) => xxh128(data);

/**
 * Build a Merkle tree from local files.
 *
 * Each directory's hash is computed from sorted child name:hash pairs.
 * Any file change propagates up to all ancestor directories.
 *
 * @param hashFn Optional hash function override (default: xxHash-128).
 * @returns Map of directory relative path → tree hash ("" = root)
 */
interface ChildEntry {
  name: string;
  isDir: boolean;
  rel: RelPath;
  absPath: string;
}

function buildChildrenOf(localFiles: ReadonlyMap<RelPath, LocalFile>): {
  dirs: Set<RelPath>;
  childrenOf: Map<RelPath, ChildEntry[]>;
} {
  const dirs = new Set<RelPath>(['' as RelPath]);
  const childrenOf = new Map<RelPath, ChildEntry[]>();
  for (const [rel, info] of localFiles) {
    if (info.isDir) dirs.add(rel);
    const slashIdx = (rel as string).lastIndexOf('/');
    const parent = (slashIdx < 0 ? '' : (rel as string).slice(0, slashIdx)) as RelPath;
    const name = slashIdx < 0 ? (rel as string) : (rel as string).slice(slashIdx + 1);
    let list = childrenOf.get(parent);
    if (!list) {
      list = [];
      childrenOf.set(parent, list);
    }
    list.push({ name, isDir: info.isDir, rel, absPath: info.path });
  }
  return { dirs, childrenOf };
}

interface ComputeDirHashParams {
  dir: RelPath;
  childrenOf: Map<RelPath, ChildEntry[]>;
  result: Map<RelPath, TreeHash>;
  hashCache: ReadonlyMap<RelPath, ContentHash | null>;
  hashFn: HashFn;
}

function computeDirHash(params: ComputeDirHashParams): TreeHash {
  const { dir: d, childrenOf, result, hashCache, hashFn } = params;
  const childHashes: [string, string][] = [];
  for (const child of childrenOf.get(d) ?? []) {
    const hash = child.isDir
      ? (result.get(child.rel) ?? 'unknown')
      : (hashCache.get(child.rel) ?? 'unknown');
    childHashes.push([child.name, hash]);
  }
  childHashes.sort((a, b) => a[0].localeCompare(b[0]));
  const data = childHashes.map(([k, v]) => `${k}:${v}`).join('|');
  return hashFn(data) as TreeHash;
}

export function buildTree(
  localFiles: ReadonlyMap<RelPath, LocalFile>,
  hashCache: ReadonlyMap<RelPath, ContentHash | null>,
  hashFn: HashFn = defaultHash,
): Map<RelPath, TreeHash> {
  const { dirs, childrenOf } = buildChildrenOf(localFiles);
  const dirDepths = new Map<RelPath, number>();
  for (const d of dirs) dirDepths.set(d, d ? (d as string).split('/').length : 0);
  const sortedDirs = [...dirs].sort((a, b) => {
    const depthA = dirDepths.get(a) ?? 0;
    const depthB = dirDepths.get(b) ?? 0;
    return depthB - depthA;
  });

  const result = new Map<RelPath, TreeHash>();
  for (const d of sortedDirs) {
    result.set(d, computeDirHash({ dir: d, childrenOf, result, hashCache, hashFn }));
  }
  return result;
}

/**
 * Compare two Merkle trees and return the set of changed directory paths.
 * If roots match, returns empty set (nothing changed).
 */
export function diffTrees(
  oldHashes: ReadonlyMap<RelPath, TreeHash>,
  newHashes: ReadonlyMap<RelPath, TreeHash>,
): Set<RelPath> {
  if (oldHashes.get('' as RelPath) === newHashes.get('' as RelPath)) return new Set<RelPath>();

  const changed = new Set<RelPath>();
  const allDirs = new Set([...oldHashes.keys(), ...newHashes.keys()]);
  for (const d of allDirs) {
    if (oldHashes.get(d) !== newHashes.get(d)) {
      changed.add(d);
    }
  }
  return changed;
}
