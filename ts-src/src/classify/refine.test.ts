import { describe, expect, it } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import { refineCloudModified } from './refine.js';
import { matchesRule } from './classify.js';
import { REFINE_RULES } from './rules.js';
import type { RefineConditions } from './rules.js';
import { asContentHash, asDirId, asEpochSeconds, asFileId, NoteDomain } from '../types/common.js';
import type { MetadataRecord } from '../types/metadata.js';

function makeMeta(overrides: Partial<MetadataRecord> = {}): MetadataRecord {
  return {
    fileId: asFileId('file-1'),
    cloudMtime: asEpochSeconds(1000),
    localMtime: asEpochSeconds(1000),
    contentHash: asContentHash('hash-abc'),
    cloudContentHash: asContentHash('hash-abc'),
    parentId: asDirId('dir-1'),
    domain: NoteDomain.MARKDOWN,
    lastSyncAt: asEpochSeconds(900),
    originalDomain: null,
    createTime: asEpochSeconds(800),
    ...overrides,
  };
}

function metaWith(contentHash: string, cloudContentHash: string) {
  return makeMeta({
    contentHash: asContentHash(contentHash),
    cloudContentHash: asContentHash(cloudContentHash),
  });
}

describe('refineCloudModified', () => {
  it('cloudModifiedMtimeOnly — cloud content equals local, local unchanged', () => {
    const result = refineCloudModified(
      asContentHash('abc'),
      asContentHash('abc'),
      metaWith('abc', 'old-cloud'),
    );
    expect(result.kind).toBe('cloudModifiedMtimeOnly');
  });

  it('bothModifiedConverged — both changed but arrived at same hash', () => {
    const result = refineCloudModified(
      asContentHash('new-hash'),
      asContentHash('new-hash'),
      metaWith('old-hash', 'old-cloud'),
    );
    expect(result.kind).toBe('bothModifiedConverged');
  });

  it('localModified — cloud hash same as metadata, local hash different', () => {
    const result = refineCloudModified(
      asContentHash('local-new'),
      asContentHash('cloud-same'),
      metaWith('old-local', 'cloud-same'),
    );
    expect(result.kind).toBe('localModified');
  });

  it('conflict — cloud and local both changed to different content', () => {
    const result = refineCloudModified(
      asContentHash('local-v2'),
      asContentHash('cloud-v2'),
      metaWith('original', 'original'),
    );
    expect(result.kind).toBe('conflict');
  });
});

describe('Refine rules completeness', () => {
  test.prop([fc.boolean(), fc.boolean(), fc.boolean()])(
    'every refine condition combination matches exactly one rule',
    (cloudEqLocal, localChanged, cloudEqMeta) => {
      const cond: RefineConditions = {
        cloudHashEqualLocal: cloudEqLocal,
        localHashChanged: localChanged,
        cloudHashEqualMeta: cloudEqMeta,
      };
      const matches = REFINE_RULES.filter((r) => matchesRule(cond, r.when));
      expect(matches.length).toBe(1);
    },
  );
});
