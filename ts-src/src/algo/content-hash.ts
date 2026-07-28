import { asContentHash, type ContentHash } from '../types/common.js';

/**
 * XXH3-128 of empty bytes. Historically written as contentHash for empty
 * voice shells / empty downloads — useless for move pairing and collides
 * across unrelated files.
 */
export const EMPTY_CONTENT_HASH: ContentHash = asContentHash('99aa06d3014798d86001c324468d497f');

/** True for null/undefined or the empty-bytes content hash. */
export function isUnusableContentHash(hash: ContentHash | null | undefined): boolean {
  return hash == null || hash === EMPTY_CONTENT_HASH;
}
