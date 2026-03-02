import type { ContentHash } from './types/common.js';
import type { MetadataStore } from './metadata/store.js';

export interface DedupStats {
  total: number;
  duplicates: number;
  deleted: number;
}

/**
 * Find duplicate files based on content hash.
 *
 * For each group of files with the same hash, keeps the one
 * with the newest last_sync_at and returns paths of the rest.
 */
export function findDuplicates(
  meta: MetadataStore,
): Map<ContentHash, string[]> {
  const allFiles = meta.getAllFiles();
  const byHash = new Map<ContentHash, Array<{ path: string; syncAt: number }>>();

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
    const dupPaths = entries.slice(1).map((e) => e.path);
    duplicates.set(hash, dupPaths);
  }

  return duplicates;
}

/**
 * Remove duplicate files from metadata (does not delete local files).
 * Returns stats about what was found/removed.
 */
export function removeDuplicateMetadata(meta: MetadataStore): DedupStats {
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
