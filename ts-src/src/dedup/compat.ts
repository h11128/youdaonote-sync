import type { ContentHash } from '../types/common.js';
import type { MetadataStore } from '../metadata/store.js';

/**
 * Simple duplicate finder (backward compat, metadata-only).
 * Returns hash → duplicate paths (excludes the "keeper").
 */
export function findDuplicates(meta: MetadataStore): Map<ContentHash, string[]> {
  const allFiles = meta.getAllFiles();
  const byHash = new Map<ContentHash, { path: string; syncAt: number }[]>();

  for (const [path, record] of allFiles) {
    if (!record.contentHash) continue;
    const list = byHash.get(record.contentHash) ?? [];
    list.push({ path, syncAt: record.lastSyncAt });
    byHash.set(record.contentHash, list);
  }

  const duplicates = new Map<ContentHash, string[]>();
  for (const [hash, entries] of byHash) {
    if (entries.length <= 1) continue;
    entries.sort((a, b) => b.syncAt - a.syncAt);
    duplicates.set(
      hash,
      entries.slice(1).map((e) => e.path),
    );
  }

  return duplicates;
}

/**
 * Remove duplicate files from metadata (backward compat, metadata-only).
 */
export function removeDuplicateMetadata(meta: MetadataStore): {
  total: number;
  duplicates: number;
  deleted: number;
} {
  const duplicates = findDuplicates(meta);
  let deleted = 0;
  let totalDups = 0;

  for (const paths of duplicates.values()) {
    totalDups += paths.length;
    for (const path of paths) {
      meta.removeFileInfo(path);
      deleted++;
    }
  }

  return {
    total: meta.getAllFiles().size + deleted,
    duplicates: totalDups,
    deleted,
  };
}
