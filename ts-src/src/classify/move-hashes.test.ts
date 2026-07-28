import { describe, expect, it } from 'vitest';
import { asContentHash, asRelPath } from '../types/common.js';
import type { RelPath } from '../types/common.js';
import { EMPTY_CONTENT_HASH } from '../algo/content-hash.js';
import {
  collectDeletedMoveHashes,
  isUnusableMoveHash,
  resolvePrimaryMoveHash,
} from './move-hashes.js';

describe('move-hashes', () => {
  it('treats empty-file xxh128 as unusable', () => {
    expect(isUnusableMoveHash(EMPTY_CONTENT_HASH)).toBe(true);
    expect(isUnusableMoveHash(null)).toBe(true);
    expect(isUnusableMoveHash(asContentHash('ccb818ed3fa0c4a29fbec6fe88e0f2a2'))).toBe(false);
  });

  it('resolvePrimaryMoveHash prefers local, then content, then cloud', () => {
    const local = asContentHash('local');
    const content = asContentHash('content');
    const cloud = asContentHash('cloud');
    expect(resolvePrimaryMoveHash(local, content, cloud)).toBe(local);
    expect(resolvePrimaryMoveHash(null, content, cloud)).toBe(content);
    expect(resolvePrimaryMoveHash(null, EMPTY_CONTENT_HASH, cloud)).toBe(cloud);
    expect(resolvePrimaryMoveHash(null, EMPTY_CONTENT_HASH, EMPTY_CONTENT_HASH)).toBe(null);
  });

  it('collectDeletedMoveHashes includes cloudContentHash when contentHash is empty', () => {
    const path = asRelPath('语音_x.audio');
    const cloud = asContentHash('ccb818ed3fa0c4a29fbec6fe88e0f2a2');
    const meta = {
      getFileInfo: (p: RelPath) =>
        p === path ? { contentHash: EMPTY_CONTENT_HASH, cloudContentHash: cloud } : null,
    };
    const hashes = collectDeletedMoveHashes(path, EMPTY_CONTENT_HASH, meta as never);
    expect(hashes).toEqual([cloud]);
  });

  it('collectDeletedMoveHashes keeps only primary when it is usable', () => {
    const path = asRelPath('note.md');
    const content = asContentHash('content-hash');
    const cloud = asContentHash('cloud-hash');
    const meta = {
      getFileInfo: (p: RelPath) =>
        p === path ? { contentHash: content, cloudContentHash: cloud } : null,
    };
    expect(collectDeletedMoveHashes(path, content, meta as never)).toEqual([content]);
  });
});
