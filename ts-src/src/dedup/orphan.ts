import { basename } from 'node:path';
import type { ContentHash } from '../types/common.js';
import { sanitizeFilename } from '../util/path.js';

/**
 * Discard orphan local duplicates before sync (matches Python discard_orphan_duplicates).
 *
 * If a local-only file has the same content as a file on both sides,
 * it's an orphan from a cloud rename — skip uploading it.
 */
export function discardOrphanDuplicates(
  cloudSnap: ReadonlyMap<string, { isDir: boolean }>,
  localSnap: ReadonlyMap<string, { isDir: boolean; path: string }>,
  localHashes: ReadonlyMap<string, ContentHash | null>,
): Set<string> {
  const skipped = new Set<string>();
  const onlyLocal = new Set<string>();
  const both = new Set<string>();

  for (const [p, info] of localSnap) {
    if (info.isDir) continue;
    (cloudSnap.has(p) ? both : onlyLocal).add(p);
  }

  if (onlyLocal.size === 0 || both.size === 0) return skipped;

  const bothByName = new Map<string, string[]>();
  for (const bp of both) {
    const norm = sanitizeFilename(basename(bp)).toLowerCase();
    const list = bothByName.get(norm) ?? [];
    list.push(bp);
    bothByName.set(norm, list);
  }

  for (const lp of onlyLocal) {
    const lpHash = localHashes.get(lp);
    if (!lpHash) continue;

    const candidates = bothByName.get(sanitizeFilename(basename(lp)).toLowerCase());
    if (!candidates) continue;

    if (candidates.some((bp) => localHashes.get(bp) === lpHash)) {
      skipped.add(lp);
    }
  }

  return skipped;
}
