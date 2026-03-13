import { describe, expect, it } from 'vitest';
import { removeDuplicateMetadata } from './compat.js';
import type { MetadataStore } from '../metadata/store.js';
import type { MetadataRecord } from '../types/metadata.js';
import {
  asContentHash,
  asEpochSeconds,
  asFileId,
  asRelPath,
  type RelPath,
} from '../types/common.js';
import { NoteDomain } from '../types/common.js';

function makeMeta(overrides: Partial<MetadataRecord> = {}): MetadataRecord {
  return {
    fileId: asFileId('f1'),
    cloudMtime: asEpochSeconds(1),
    localMtime: asEpochSeconds(1),
    contentHash: asContentHash('hash'),
    cloudContentHash: asContentHash('hash'),
    parentId: null,
    domain: NoteDomain.MARKDOWN,
    lastSyncAt: asEpochSeconds(100),
    originalDomain: null,
    createTime: asEpochSeconds(1),
    ...overrides,
  };
}

function createMockStore(entries: [string, MetadataRecord][]): MetadataStore {
  const files = new Map(entries.map(([p, r]) => [asRelPath(p), r]));
  const mockMeta = {
    getAllFiles: () => files,
    removeFileInfo: (p: RelPath) => {
      files.delete(p);
    },
  } as unknown as MetadataStore;
  return mockMeta;
}

describe('removeDuplicateMetadata', () => {
  it('no duplicates → { total: N, duplicates: 0, deleted: 0 }', () => {
    const meta = createMockStore([
      ['a.md', makeMeta({ contentHash: asContentHash('h1') })],
      ['b.md', makeMeta({ contentHash: asContentHash('h2') })],
      ['c.md', makeMeta({ contentHash: asContentHash('h3') })],
    ]);

    const result = removeDuplicateMetadata(meta);

    expect(result).toEqual({ total: 3, duplicates: 0, deleted: 0 });
  });

  it('two files with same contentHash → removes one with older lastSyncAt', () => {
    const meta = createMockStore([
      ['keep.md', makeMeta({ contentHash: asContentHash('dup'), lastSyncAt: asEpochSeconds(200) })],
      [
        'remove.md',
        makeMeta({ contentHash: asContentHash('dup'), lastSyncAt: asEpochSeconds(100) }),
      ],
    ]);

    const result = removeDuplicateMetadata(meta);

    expect(result).toEqual({ total: 2, duplicates: 1, deleted: 1 });
    expect(meta.getAllFiles().has(asRelPath('remove.md'))).toBe(false);
    expect(meta.getAllFiles().has(asRelPath('keep.md'))).toBe(true);
  });

  it('three files with same hash → removes two oldest', () => {
    const meta = createMockStore([
      ['newest.md', makeMeta({ contentHash: asContentHash('h'), lastSyncAt: asEpochSeconds(300) })],
      ['mid.md', makeMeta({ contentHash: asContentHash('h'), lastSyncAt: asEpochSeconds(200) })],
      ['oldest.md', makeMeta({ contentHash: asContentHash('h'), lastSyncAt: asEpochSeconds(100) })],
    ]);

    const result = removeDuplicateMetadata(meta);

    expect(result).toEqual({ total: 3, duplicates: 2, deleted: 2 });
    expect(meta.getAllFiles().has(asRelPath('newest.md'))).toBe(true);
    expect(meta.getAllFiles().has(asRelPath('mid.md'))).toBe(false);
    expect(meta.getAllFiles().has(asRelPath('oldest.md'))).toBe(false);
  });

  it('multiple hash groups → correct totals', () => {
    const meta = createMockStore([
      ['a1.md', makeMeta({ contentHash: asContentHash('g1'), lastSyncAt: asEpochSeconds(100) })],
      ['a2.md', makeMeta({ contentHash: asContentHash('g1'), lastSyncAt: asEpochSeconds(200) })],
      ['b1.md', makeMeta({ contentHash: asContentHash('g2'), lastSyncAt: asEpochSeconds(50) })],
      ['b2.md', makeMeta({ contentHash: asContentHash('g2'), lastSyncAt: asEpochSeconds(150) })],
      ['c.md', makeMeta({ contentHash: asContentHash('g3') })],
    ]);

    const result = removeDuplicateMetadata(meta);

    expect(result).toEqual({ total: 5, duplicates: 2, deleted: 2 });
    expect(meta.getAllFiles().has(asRelPath('a2.md'))).toBe(true);
    expect(meta.getAllFiles().has(asRelPath('a1.md'))).toBe(false);
    expect(meta.getAllFiles().has(asRelPath('b2.md'))).toBe(true);
    expect(meta.getAllFiles().has(asRelPath('b1.md'))).toBe(false);
    expect(meta.getAllFiles().has(asRelPath('c.md'))).toBe(true);
  });

  it('files with no contentHash → not included in duplicates', () => {
    const meta = createMockStore([
      ['no-hash.md', makeMeta({ contentHash: null })],
      ['with-hash.md', makeMeta({ contentHash: asContentHash('h') })],
    ]);

    const result = removeDuplicateMetadata(meta);

    expect(result).toEqual({ total: 2, duplicates: 0, deleted: 0 });
    expect(meta.getAllFiles().size).toBe(2);
  });
});
