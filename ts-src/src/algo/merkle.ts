import { xxh128 } from './xxhash.js';
import type { ContentHash } from '../types/common.js';
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
  rel: string;
  absPath: string;
}

function buildChildrenOf(localFiles: ReadonlyMap<string, LocalFile>): {
  dirs: Set<string>;
  childrenOf: Map<string, ChildEntry[]>;
} {
  const dirs = new Set<string>(['']);
  const childrenOf = new Map<string, ChildEntry[]>();
  for (const [rel, info] of localFiles) {
    if (info.isDir) dirs.add(rel);
    const slashIdx = rel.lastIndexOf('/');
    const parent = slashIdx < 0 ? '' : rel.slice(0, slashIdx);
    const name = slashIdx < 0 ? rel : rel.slice(slashIdx + 1);
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
  dir: string;
  childrenOf: Map<string, ChildEntry[]>;
  result: Map<string, TreeHash>;
  hashCache: ReadonlyMap<string, ContentHash | null>;
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
  localFiles: ReadonlyMap<string, LocalFile>,
  hashCache: ReadonlyMap<string, ContentHash | null>,
  hashFn: HashFn = defaultHash,
): Map<string, TreeHash> {
  const { dirs, childrenOf } = buildChildrenOf(localFiles);
  const dirDepths = new Map<string, number>();
  for (const d of dirs) dirDepths.set(d, d ? d.split('/').length : 0);
  const sortedDirs = [...dirs].sort((a, b) => {
    const depthA = dirDepths.get(a) ?? 0;
    const depthB = dirDepths.get(b) ?? 0;
    return depthB - depthA;
  });

  const result = new Map<string, TreeHash>();
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
  oldHashes: ReadonlyMap<string, TreeHash>,
  newHashes: ReadonlyMap<string, TreeHash>,
): Set<string> {
  if (oldHashes.get('') === newHashes.get('')) return new Set();

  const changed = new Set<string>();
  const allDirs = new Set([...oldHashes.keys(), ...newHashes.keys()]);
  for (const d of allDirs) {
    if (oldHashes.get(d) !== newHashes.get(d)) {
      changed.add(d);
    }
  }
  return changed;
}
