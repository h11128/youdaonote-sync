import type { ContentHash, RelPath } from '../types/common.js';
import type { MetadataStore } from '../metadata/store.js';
import { isUnusableContentHash } from '../algo/content-hash.js';

export {
  EMPTY_CONTENT_HASH,
  isUnusableContentHash as isUnusableMoveHash,
} from '../algo/content-hash.js';

/** Prefer local disk hash, then usable contentHash, then cloudContentHash. */
export function resolvePrimaryMoveHash(
  localHash: ContentHash | null | undefined,
  contentHash: ContentHash | null | undefined,
  cloudContentHash: ContentHash | null | undefined,
): ContentHash | null {
  if (localHash && !isUnusableContentHash(localHash)) return localHash;
  if (contentHash && !isUnusableContentHash(contentHash)) return contentHash;
  if (cloudContentHash && !isUnusableContentHash(cloudContentHash)) return cloudContentHash;
  return null;
}

/**
 * Usable hashes for a deleted path during move matching.
 * If the primary (classified) hash is usable, return only that — avoids
 * registering the same path under both stale contentHash and cloudContentHash.
 * When primary is empty/missing, fall back to cloudContentHash then contentHash.
 */
export function collectDeletedMoveHashes(
  path: RelPath,
  primaryHash: ContentHash | null,
  meta: MetadataStore | undefined,
): ContentHash[] {
  const out: ContentHash[] = [];
  const seen = new Set<string>();
  const push = (h: ContentHash | null | undefined): void => {
    if (!h || isUnusableContentHash(h) || seen.has(h)) return;
    seen.add(h);
    out.push(h);
  };
  push(primaryHash);
  if (out.length > 0) return out;
  const rec = meta?.getFileInfo(path);
  push(rec?.cloudContentHash ?? null);
  push(rec?.contentHash ?? null);
  return out;
}
