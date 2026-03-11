import { basename } from 'node:path';
import { type ContentHash, type EpochSeconds, type RelPath } from '../types/common.js';
import type { MetadataStore } from '../metadata/store.js';
import { computeContentHashFromFile } from '../hash.js';
import { walkFiles } from './walk.js';

export interface BuildIndexOpts {
  hashCache?: Map<string, ContentHash> | undefined;
  localFiles?: Map<RelPath, { path: string; mtime: EpochSeconds; isDir: boolean }> | undefined;
}

/**
 * Build a hash → paths index by scanning the filesystem (matches Python build_all_indexes).
 *
 * Hash resolution order: hashCache → metadata mtime match → compute from file.
 */
export function buildHashIndex(
  root: string,
  meta: MetadataStore,
  opts?: BuildIndexOpts,
): Map<ContentHash, RelPath[]> {
  if (!root || typeof root !== 'string') {
    throw new Error('buildHashIndex: root must be a non-empty string');
  }
  const index = new Map<ContentHash, RelPath[]>();
  const hashCache = opts?.hashCache;
  const allMeta = meta.getAllFiles();
  let updated = 0;

  const processFile = (rel: RelPath, absPath: string, mtime: EpochSeconds): void => {
    if (basename(rel).startsWith('.') || rel.includes('.conflict.')) return;

    let h: ContentHash | null = hashCache?.get(absPath) ?? null;

    if (!h) {
      const metaInfo = allMeta.get(rel);
      if (metaInfo?.contentHash && metaInfo.localMtime === mtime) {
        h = metaInfo.contentHash;
      }
    }

    if (!h) {
      h = computeContentHashFromFile(absPath);
      if (h) {
        if (hashCache) hashCache.set(absPath, h);
        if (allMeta.has(rel)) {
          meta.updateContentHash(rel, h);
          updated++;
        }
      }
    }

    if (h) {
      const list = index.get(h) ?? [];
      list.push(rel);
      index.set(h, list);
    }
  };

  if (opts?.localFiles) {
    for (const [rel, info] of opts.localFiles) {
      if (info.isDir) continue;
      processFile(rel, info.path, info.mtime);
    }
  } else {
    walkFiles(root, root, (entry) => {
      processFile(entry.rel, entry.absPath, entry.mtime);
    });
  }

  if (updated > 0) meta.save();
  return index;
}
