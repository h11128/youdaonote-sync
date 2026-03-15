import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../metadata/store.js';
import { asFileId, asContentHash, asEpochSeconds, asRelPath } from '../types/common.js';
import type { FileId } from '../types/common.js';
import { autoDedup, buildRefIndex, buildHashIndex, findDuplicates } from './index.js';

function setupDedupContext() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dedup-test-'));
  const root = join(tmpDir, 'notes');
  const metaPath = join(tmpDir, 'meta.db');
  mkdirSync(root, { recursive: true });
  const meta = new MetadataStore(metaPath);
  const cleanup = () => {
    meta.close();
    rmSync(tmpDir, { recursive: true, force: true });
  };
  return { tmpDir, root, metaPath, meta, cleanup };
}

describe('dedup buildRefIndex', () => {
  let root: string;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupDedupContext();
    root = ctx.root;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('extracts markdown image references', () => {
    writeFileSync(join(root, 'note.md'), '![img](images/photo.png)\ntext');
    mkdirSync(join(root, 'images'), { recursive: true });
    writeFileSync(join(root, 'images', 'photo.png'), 'fake-png');

    const refs = buildRefIndex(root);

    expect(refs.has(asRelPath('images/photo.png'))).toBe(true);
  });

  it('ignores http URLs', () => {
    writeFileSync(join(root, 'note.md'), '![img](https://example.com/img.png)');

    const refs = buildRefIndex(root);

    expect(refs.size).toBe(0);
  });

  it('extracts markdown link references (not just images)', () => {
    writeFileSync(join(root, 'index.md'), '[see details](other.md)\n![pic](img.png)');

    const refs = buildRefIndex(root);

    expect(refs.has(asRelPath('other.md'))).toBe(true);
    expect(refs.has(asRelPath('img.png'))).toBe(true);
  });
});

describe('dedup buildHashIndex', () => {
  let root: string;
  let meta: MetadataStore;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupDedupContext();
    root = ctx.root;
    meta = ctx.meta;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('groups files by content hash from filesystem', () => {
    const hash = asContentHash('abc123');
    writeFileSync(join(root, 'a.md'), 'content-a');
    writeFileSync(join(root, 'b.md'), 'content-b');
    writeFileSync(join(root, 'c.md'), 'content-c');

    meta.setFileInfo(asRelPath('a.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(Math.floor(Date.now() / 1000)),
      contentHash: hash,
    });
    meta.setFileInfo(asRelPath('b.md'), {
      fileId: asFileId('f2'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(Math.floor(Date.now() / 1000)),
      contentHash: hash,
    });
    meta.setFileInfo(asRelPath('c.md'), {
      fileId: asFileId('f3'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(Math.floor(Date.now() / 1000)),
      contentHash: asContentHash('other'),
    });

    const index = buildHashIndex(root, meta);

    expect(index.size).toBeGreaterThanOrEqual(1);
  });
});

describe('dedup findDuplicates', () => {
  let meta: MetadataStore;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupDedupContext();
    meta = ctx.meta;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('returns duplicates sorted by lastSyncAt', () => {
    const hash = asContentHash('same-hash');
    meta.setFileInfo(asRelPath('old.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
      lastSyncAt: asEpochSeconds(100),
    });
    meta.setFileInfo(asRelPath('new.md'), {
      fileId: asFileId('f2'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
      lastSyncAt: asEpochSeconds(200),
    });

    const dups = findDuplicates(meta);

    expect(dups.get(hash)).toEqual([asRelPath('old.md')]);
  });
});

describe('dedup autoDedup group handling', () => {
  let root: string;
  let meta: MetadataStore;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupDedupContext();
    root = ctx.root;
    meta = ctx.meta;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('case A: mixed group — deletes local orphan, keeps cloud version', async () => {
    const hash = asContentHash('dup-hash');

    writeFileSync(join(root, 'cloud-ver.md'), 'content');
    meta.setFileInfo(asRelPath('cloud-ver.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });

    writeFileSync(join(root, 'local-orphan.md'), 'content');
    meta.setFileInfo(asRelPath('local-orphan.md'), {
      fileId: '' as FileId,
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });

    const { stats } = await autoDedup(root, meta);

    expect(stats.deleted).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(root, 'local-orphan.md'))).toBe(false);
    expect(existsSync(join(root, 'cloud-ver.md'))).toBe(true);
  });

  it('case B: all-cloud group — keeps one, deletes rest', async () => {
    const hash = asContentHash('cloud-dup');

    mkdirSync(join(root, 'deep', 'path'), { recursive: true });
    writeFileSync(join(root, 'deep', 'path', 'doc.md'), 'same');
    writeFileSync(join(root, 'dup.md'), 'same');

    meta.setFileInfo(asRelPath('deep/path/doc.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });
    meta.setFileInfo(asRelPath('dup.md'), {
      fileId: asFileId('f2'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });

    const mockApi = { deleteFile: () => Promise.resolve({}) };
    const { stats } = await autoDedup(root, meta, { api: mockApi as any });

    expect(stats.groups).toBe(1);
    expect(stats.deleted).toBeGreaterThanOrEqual(1);
    expect(stats.cloudDeleted).toBeGreaterThanOrEqual(1);
  });
});

describe('dedup autoDedup local and skip', () => {
  let root: string;
  let meta: MetadataStore;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupDedupContext();
    root = ctx.root;
    meta = ctx.meta;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('case C: all-local group — skipped', async () => {
    const hash = asContentHash('local-only-dup');

    writeFileSync(join(root, 'a.md'), 'same');
    writeFileSync(join(root, 'b.md'), 'same');

    meta.setFileInfo(asRelPath('a.md'), {
      fileId: '' as FileId,
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });
    meta.setFileInfo(asRelPath('b.md'), {
      fileId: '' as FileId,
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });

    const { stats } = await autoDedup(root, meta);

    expect(stats.deleted).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe('dedup autoDedup protection and options', () => {
  let root: string;
  let meta: MetadataStore;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupDedupContext();
    root = ctx.root;
    meta = ctx.meta;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('protects referenced assets from deletion', async () => {
    const hash = asContentHash('img-dup');

    writeFileSync(join(root, 'note.md'), '![pic](photo.png)');
    writeFileSync(join(root, 'photo.png'), 'img-data');

    mkdirSync(join(root, 'cloud'), { recursive: true });
    writeFileSync(join(root, 'cloud', 'photo.png'), 'img-data');

    meta.setFileInfo(asRelPath('cloud/photo.png'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });
    meta.setFileInfo(asRelPath('photo.png'), {
      fileId: '' as FileId,
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });

    const { stats } = await autoDedup(root, meta);

    expect(stats.protectedRefs).toBe(1);
    expect(existsSync(join(root, 'photo.png'))).toBe(true);
  });

  it('dryRun does not delete anything', async () => {
    const hash = asContentHash('dry-hash');

    writeFileSync(join(root, 'cloud.md'), 'content');
    writeFileSync(join(root, 'orphan.md'), 'content');
    meta.setFileInfo(asRelPath('cloud.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });
    meta.setFileInfo(asRelPath('orphan.md'), {
      fileId: '' as FileId,
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });

    await autoDedup(root, meta, { dryRun: true });

    expect(existsSync(join(root, 'orphan.md'))).toBe(true);
  });

  it('skips empty files', async () => {
    const hash = asContentHash('empty-hash');

    writeFileSync(join(root, 'empty1.md'), '');
    writeFileSync(join(root, 'empty2.md'), '');
    meta.setFileInfo(asRelPath('empty1.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });
    meta.setFileInfo(asRelPath('empty2.md'), {
      fileId: asFileId('f2'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: hash,
    });

    const { stats } = await autoDedup(root, meta);

    expect(stats.skipped).toBeGreaterThanOrEqual(1);
  });
});
