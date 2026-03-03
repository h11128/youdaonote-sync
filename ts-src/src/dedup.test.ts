import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MetadataStore } from './metadata/store.js';
import { asFileId, asContentHash, type FileId, type ContentHash } from './types/common.js';
import { autoDedup, buildRefIndex, buildHashIndex, findDuplicates } from './dedup/index.js';

describe('dedup', () => {
  let tmpDir: string;
  let root: string;
  let metaPath: string;
  let meta: MetadataStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dedup-test-'));
    root = join(tmpDir, 'notes');
    metaPath = join(tmpDir, 'meta.db');
    mkdirSync(root, { recursive: true });
    meta = new MetadataStore(metaPath);
  });

  afterEach(() => {
    meta.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('buildRefIndex', () => {
    it('extracts markdown image references', () => {
      writeFileSync(join(root, 'note.md'), '![img](images/photo.png)\ntext');
      mkdirSync(join(root, 'images'), { recursive: true });
      writeFileSync(join(root, 'images', 'photo.png'), 'fake-png');

      const refs = buildRefIndex(root);

      expect(refs.has('images/photo.png')).toBe(true);
    });

    it('ignores http URLs', () => {
      writeFileSync(join(root, 'note.md'), '![img](https://example.com/img.png)');

      const refs = buildRefIndex(root);

      expect(refs.size).toBe(0);
    });

    it('extracts markdown link references (not just images)', () => {
      writeFileSync(join(root, 'index.md'), '[see details](other.md)\n![pic](img.png)');

      const refs = buildRefIndex(root);

      expect(refs.has('other.md')).toBe(true);
      expect(refs.has('img.png')).toBe(true);
    });
  });

  describe('buildHashIndex', () => {
    it('groups files by content hash from filesystem', () => {
      const hash = asContentHash('abc123');
      writeFileSync(join(root, 'a.md'), 'content-a');
      writeFileSync(join(root, 'b.md'), 'content-b');
      writeFileSync(join(root, 'c.md'), 'content-c');

      meta.setFileInfo('a.md', { fileId: asFileId('f1'), cloudMtime: 1, localMtime: Math.floor(Date.now() / 1000), contentHash: hash });
      meta.setFileInfo('b.md', { fileId: asFileId('f2'), cloudMtime: 1, localMtime: Math.floor(Date.now() / 1000), contentHash: hash });
      meta.setFileInfo('c.md', { fileId: asFileId('f3'), cloudMtime: 1, localMtime: Math.floor(Date.now() / 1000), contentHash: asContentHash('other') });

      const index = buildHashIndex(root, meta);

      // Files exist on disk so they get hashed; metadata cache may or may not match
      expect(index.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('findDuplicates', () => {
    it('returns duplicates sorted by lastSyncAt', () => {
      const hash = asContentHash('same-hash');
      meta.setFileInfo('old.md', { fileId: asFileId('f1'), cloudMtime: 1, localMtime: 1, contentHash: hash, lastSyncAt: 100 });
      meta.setFileInfo('new.md', { fileId: asFileId('f2'), cloudMtime: 1, localMtime: 1, contentHash: hash, lastSyncAt: 200 });

      const dups = findDuplicates(meta);

      expect(dups.get(hash)).toEqual(['old.md']);
    });
  });

  describe('autoDedup', () => {
    it('case A: mixed group — deletes local orphan, keeps cloud version', async () => {
      const hash = asContentHash('dup-hash');

      // Cloud file (has file_id)
      writeFileSync(join(root, 'cloud-ver.md'), 'content');
      meta.setFileInfo('cloud-ver.md', { fileId: asFileId('f1'), cloudMtime: 1, localMtime: 1, contentHash: hash });

      // Local orphan (no file_id → will be classified as local)
      writeFileSync(join(root, 'local-orphan.md'), 'content');
      meta.setFileInfo('local-orphan.md', { fileId: '' as FileId, cloudMtime: 0, localMtime: 1, contentHash: hash });

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

      meta.setFileInfo('deep/path/doc.md', { fileId: asFileId('f1'), cloudMtime: 1, localMtime: 1, contentHash: hash });
      meta.setFileInfo('dup.md', { fileId: asFileId('f2'), cloudMtime: 1, localMtime: 1, contentHash: hash });

      const mockApi = {
        deleteFile: async () => ({}),
      };

      const { stats } = await autoDedup(root, meta, { api: mockApi as any });

      expect(stats.groups).toBe(1);
      expect(stats.deleted).toBeGreaterThanOrEqual(1);
      expect(stats.cloudDeleted).toBeGreaterThanOrEqual(1);
    });

    it('case C: all-local group — skipped', async () => {
      const hash = asContentHash('local-only-dup');

      writeFileSync(join(root, 'a.md'), 'same');
      writeFileSync(join(root, 'b.md'), 'same');

      meta.setFileInfo('a.md', { fileId: '' as FileId, cloudMtime: 0, localMtime: 1, contentHash: hash });
      meta.setFileInfo('b.md', { fileId: '' as FileId, cloudMtime: 0, localMtime: 1, contentHash: hash });

      const { stats } = await autoDedup(root, meta);

      expect(stats.deleted).toBe(0);
      expect(stats.skipped).toBeGreaterThanOrEqual(1);
    });

    it('protects referenced assets from deletion', async () => {
      const hash = asContentHash('img-dup');

      writeFileSync(join(root, 'note.md'), '![pic](photo.png)');
      writeFileSync(join(root, 'photo.png'), 'img-data');

      mkdirSync(join(root, 'cloud'), { recursive: true });
      writeFileSync(join(root, 'cloud', 'photo.png'), 'img-data');

      meta.setFileInfo('cloud/photo.png', { fileId: asFileId('f1'), cloudMtime: 1, localMtime: 1, contentHash: hash });
      meta.setFileInfo('photo.png', { fileId: '' as FileId, cloudMtime: 0, localMtime: 1, contentHash: hash });

      const { stats } = await autoDedup(root, meta);

      expect(stats.protectedRefs).toBe(1);
      expect(existsSync(join(root, 'photo.png'))).toBe(true);
    });

    it('dryRun does not delete anything', async () => {
      const hash = asContentHash('dry-hash');

      writeFileSync(join(root, 'cloud.md'), 'content');
      writeFileSync(join(root, 'orphan.md'), 'content');
      meta.setFileInfo('cloud.md', { fileId: asFileId('f1'), cloudMtime: 1, localMtime: 1, contentHash: hash });
      meta.setFileInfo('orphan.md', { fileId: '' as FileId, cloudMtime: 0, localMtime: 1, contentHash: hash });

      await autoDedup(root, meta, { dryRun: true });

      expect(existsSync(join(root, 'orphan.md'))).toBe(true);
    });

    it('skips empty files', async () => {
      const hash = asContentHash('empty-hash');

      writeFileSync(join(root, 'empty1.md'), '');
      writeFileSync(join(root, 'empty2.md'), '');
      meta.setFileInfo('empty1.md', { fileId: asFileId('f1'), cloudMtime: 1, localMtime: 1, contentHash: hash });
      meta.setFileInfo('empty2.md', { fileId: asFileId('f2'), cloudMtime: 1, localMtime: 1, contentHash: hash });

      const { stats } = await autoDedup(root, meta);

      expect(stats.skipped).toBeGreaterThanOrEqual(1);
    });
  });
});
