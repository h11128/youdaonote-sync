import { createHash } from 'node:crypto';
import type { ContentHash } from '../types/common.js';
import type { LocalFile } from '../types/scan.js';

export type TreeHash = string & { readonly __brand: 'TreeHash' };

export type HashFn = (data: string) => string;

const defaultHash: HashFn = (data) =>
  createHash('md5').update(data, 'utf-8').digest('hex');

/**
 * Build a Merkle tree from local files.
 *
 * Each directory's hash is computed from sorted child name:hash pairs.
 * Any file change propagates up to all ancestor directories.
 *
 * @param hashFn Optional hash function override (default: MD5). Pass xxhash for speed.
 * @returns Map of directory relative path → tree hash ("" = root)
 */
export function buildTree(
  localFiles: ReadonlyMap<string, LocalFile>,
  hashCache: ReadonlyMap<string, ContentHash | null>,
  hashFn: HashFn = defaultHash,
): Map<string, TreeHash> {
  const dirs = new Set<string>(['']);
  const childrenOf = new Map<string, Array<{ name: string; isDir: boolean; rel: string; absPath: string }>>();

  for (const [rel, info] of localFiles) {
    if (info.isDir) dirs.add(rel);
    const slashIdx = rel.lastIndexOf('/');
    const parent = slashIdx < 0 ? '' : rel.slice(0, slashIdx);
    const name = slashIdx < 0 ? rel : rel.slice(slashIdx + 1);
    let list = childrenOf.get(parent);
    if (!list) { list = []; childrenOf.set(parent, list); }
    list.push({ name, isDir: info.isDir, rel, absPath: info.path });
  }

  // Bottom-up: deepest dirs first (pre-compute depth to avoid repeated split)
  const dirDepths = new Map<string, number>();
  for (const d of dirs) dirDepths.set(d, d ? d.split('/').length : 0);
  const sortedDirs = [...dirs].sort((a, b) => dirDepths.get(b)! - dirDepths.get(a)!);

  const result = new Map<string, TreeHash>();
  for (const d of sortedDirs) {
    const childHashes: Array<[string, string]> = [];
    for (const child of childrenOf.get(d) ?? []) {
      if (child.isDir) {
        childHashes.push([child.name, result.get(child.rel) ?? 'unknown']);
      } else {
        childHashes.push([child.name, hashCache.get(child.rel) ?? 'unknown']);
      }
    }
    childHashes.sort((a, b) => a[0].localeCompare(b[0]));
    const data = childHashes.map(([k, v]) => `${k}:${v}`).join('|');
    result.set(d, hashFn(data) as TreeHash);
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
