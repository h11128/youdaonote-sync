import { describe, expect, it } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import { classify, classifyAll, matchesRule } from './classify.js';
import { extractConditions } from './conditions.js';
import type { ClassifyInput, Conditions } from './conditions.js';
import { RULES } from './rules.js';
import { asContentHash, asDirId, asFileId, NoteDomain } from '../types/common.js';
import type { ContentHash } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { MetadataRecord } from '../types/metadata.js';

// --- Test helpers ---

function makeCloud(overrides: Partial<CloudFile> = {}): CloudFile {
  return {
    id: asFileId('file-1'),
    parentId: asDirId('dir-1'),
    name: 'test.md',
    isDir: false,
    mtime: 1000,
    ctime: 500,
    domain: NoteDomain.MARKDOWN,
    ...overrides,
  };
}

function makeLocal(overrides: Partial<LocalFile> = {}): LocalFile {
  return {
    path: '/notes/test.md',
    isDir: false,
    mtime: 1000,
    ...overrides,
  };
}

function makeMeta(overrides: Partial<MetadataRecord> = {}): MetadataRecord {
  return {
    fileId: asFileId('file-1'),
    cloudMtime: 1000,
    localMtime: 1000,
    contentHash: asContentHash('hash-abc'),
    cloudContentHash: asContentHash('hash-abc'),
    parentId: asDirId('dir-1'),
    domain: NoteDomain.MARKDOWN,
    lastSyncAt: 900,
    originalDomain: null,
    ...overrides,
  };
}

// --- 14 FileState kind tests ---

describe('classify: each FileState kind', () => {
  it('synced — both exist, nothing changed', () => {
    const result = classify({
      local: makeLocal(),
      cloud: makeCloud(),
      meta: makeMeta(),
      localHash: asContentHash('hash-abc'),
    });
    expect(result.kind).toBe('synced');
  });

  it('localNew — local exists, cloud does not, never synced', () => {
    const result = classify({
      local: makeLocal(),
      cloud: null,
      meta: null,
      localHash: asContentHash('hash-new'),
    });
    expect(result.kind).toBe('localNew');
  });

  it('cloudNew — cloud exists, local does not, never synced', () => {
    const result = classify({
      local: null,
      cloud: makeCloud(),
      meta: null,
      localHash: null,
    });
    expect(result.kind).toBe('cloudNew');
  });

  it('localDeleted — local gone, cloud unchanged since last sync', () => {
    const result = classify({
      local: null,
      cloud: makeCloud({ mtime: 1000 }),
      meta: makeMeta({ cloudMtime: 1000 }),
      localHash: null,
    });
    expect(result.kind).toBe('localDeleted');
  });

  it('localDeletedCloudModified — local gone, cloud changed since last sync', () => {
    const result = classify({
      local: null,
      cloud: makeCloud({ mtime: 2000 }),
      meta: makeMeta({ cloudMtime: 1000 }),
      localHash: null,
    });
    expect(result.kind).toBe('localDeletedCloudModified');
  });

  it('cloudDeleted — cloud gone, local unchanged since last sync', () => {
    const result = classify({
      local: makeLocal({ mtime: 1000 }),
      cloud: null,
      meta: makeMeta({ localMtime: 1000 }),
      localHash: null,
    });
    expect(result.kind).toBe('cloudDeleted');
  });

  it('cloudDeletedLocalModified — cloud gone, local changed since last sync', () => {
    const result = classify({
      local: makeLocal({ mtime: 2000 }),
      cloud: null,
      meta: makeMeta({ localMtime: 1000 }),
      localHash: null,
    });
    expect(result.kind).toBe('cloudDeletedLocalModified');
  });

  it('localModified — both exist, only local hash changed', () => {
    const result = classify({
      local: makeLocal(),
      cloud: makeCloud({ mtime: 1000 }),
      meta: makeMeta({ cloudMtime: 1000 }),
      localHash: asContentHash('hash-changed'),
    });
    expect(result.kind).toBe('localModified');
  });

  it('cloudModifiedContent — both exist, only cloud mtime changed (hash not available)', () => {
    const result = classify({
      local: makeLocal(),
      cloud: makeCloud({ mtime: 2000 }),
      meta: makeMeta({ cloudMtime: 1000 }),
      localHash: null,
    });
    expect(result.kind).toBe('cloudModifiedContent');
  });

  it('conflict — both exist, both hash and cloud mtime changed', () => {
    const result = classify({
      local: makeLocal(),
      cloud: makeCloud({ mtime: 2000 }),
      meta: makeMeta({ cloudMtime: 1000 }),
      localHash: asContentHash('hash-changed'),
    });
    expect(result.kind).toBe('conflict');
  });

  it('gone — neither local nor cloud exists', () => {
    const result = classify({
      local: null,
      cloud: null,
      meta: makeMeta(),
      localHash: null,
    });
    expect(result.kind).toBe('gone');
  });

  it('cloudModifiedContent — cloud mtime changed, local hash unchanged', () => {
    const result = classify({
      local: makeLocal(),
      cloud: makeCloud({ mtime: 2000 }),
      meta: makeMeta({ cloudMtime: 1000 }),
      localHash: asContentHash('hash-abc'),
    });
    expect(result.kind).toBe('cloudModifiedContent');
  });
});

// --- extractConditions tests ---

describe('extractConditions', () => {
  it('returns all null optional fields when meta is missing', () => {
    const cond = extractConditions({
      local: makeLocal(),
      cloud: makeCloud(),
      meta: null,
      localHash: asContentHash('h'),
    });
    expect(cond.previouslySynced).toBe(false);
    expect(cond.cloudMtimeChanged).toBeNull();
    expect(cond.localMtimeChanged).toBeNull();
    expect(cond.localHashChanged).toBeNull();
  });

  it('detects hash change correctly', () => {
    const cond = extractConditions({
      local: makeLocal(),
      cloud: makeCloud(),
      meta: makeMeta({ contentHash: asContentHash('old') }),
      localHash: asContentHash('new'),
    });
    expect(cond.localHashChanged).toBe(true);
  });

  it('detects no hash change', () => {
    const cond = extractConditions({
      local: makeLocal(),
      cloud: makeCloud(),
      meta: makeMeta({ contentHash: asContentHash('same') }),
      localHash: asContentHash('same'),
    });
    expect(cond.localHashChanged).toBe(false);
  });
});

// --- Decision Table completeness (fast-check) ---

describe('Decision Table completeness', () => {
  const tri = fc.option(fc.boolean(), { nil: null });

  test.prop([fc.boolean(), fc.boolean(), fc.boolean(), tri, tri, tri])(
    'every possible condition combination matches exactly one rule',
    (le, ce, ps, lhc, cmc, lmc) => {
      const cond: Conditions = {
        localExists: le,
        cloudExists: ce,
        previouslySynced: ps,
        localHashChanged: lhc,
        cloudMtimeChanged: cmc,
        localMtimeChanged: lmc,
      };

      const matches = RULES.filter(r => matchesRule(cond, r.when));
      expect(matches.length).toBe(1);
    },
  );
});

// --- matchesRule unit tests ---

describe('matchesRule', () => {
  it('empty when matches anything', () => {
    const cond: Conditions = {
      localExists: true,
      cloudExists: false,
      previouslySynced: true,
      localHashChanged: null,
      cloudMtimeChanged: false,
      localMtimeChanged: true,
    };
    expect(matchesRule(cond, {})).toBe(true);
  });

  it('partial match succeeds when all specified fields match', () => {
    const cond: Conditions = {
      localExists: true,
      cloudExists: false,
      previouslySynced: true,
      localHashChanged: null,
      cloudMtimeChanged: null,
      localMtimeChanged: true,
    };
    expect(matchesRule(cond, { localExists: true, previouslySynced: true })).toBe(true);
  });

  it('partial match fails when any specified field differs', () => {
    const cond: Conditions = {
      localExists: true,
      cloudExists: false,
      previouslySynced: true,
      localHashChanged: null,
      cloudMtimeChanged: null,
      localMtimeChanged: true,
    };
    expect(matchesRule(cond, { localExists: false })).toBe(false);
  });
});

describe('classify preconditions', () => {
  it('classify throws when input is null', () => {
    expect(() => classify(null as unknown as ClassifyInput)).toThrow(/classify input must not be null/);
  });

  it('classifyAll throws when any map is null', () => {
    const cloud = new Map();
    const local = new Map();
    const meta = new Map();
    const hashes = new Map();
    expect(() => classifyAll(null as unknown as typeof cloud, local, meta, hashes)).toThrow(/must not be null/);
    expect(() => classifyAll(cloud, null as unknown as typeof local, meta, hashes)).toThrow(/must not be null/);
    expect(() => classifyAll(cloud, local, null as unknown as typeof meta, hashes)).toThrow(/must not be null/);
    expect(() => classifyAll(cloud, local, meta, null as unknown as typeof hashes)).toThrow(/must not be null/);
  });
});
