import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MetadataStore } from './store.js';
import { asFileId, asDirId, asContentHash, NoteDomain } from '../types/common.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function fileInfoBasicTests(getStore: () => MetadataStore): void {
  describe('file info basic', () => {
    it('setFileInfo + getFileInfo round-trip', () => {
      const store = getStore();
      store.setFileInfo('notes/hello.md', {
        fileId: asFileId('f-1'),
        cloudMtime: 1000,
        localMtime: 2000,
        parentId: asDirId('d-1'),
        domain: NoteDomain.MARKDOWN,
        contentHash: asContentHash('hash-abc'),
      });
      const info = store.getFileInfo('notes/hello.md');
      expect(info).not.toBeNull();
      expect(info!.fileId).toBe('f-1');
      expect(info!.cloudMtime).toBe(1000);
      expect(info!.localMtime).toBe(2000);
      expect(info!.parentId).toBe('d-1');
      expect(info!.domain).toBe(NoteDomain.MARKDOWN);
      expect(info!.contentHash).toBe('hash-abc');
    });

    it('getFileInfo returns null for non-existent path', () => {
      expect(getStore().getFileInfo('nonexistent.md')).toBeNull();
    });

    it('getFileId returns the file ID', () => {
      const store = getStore();
      store.setFileInfo('test.md', {
        fileId: asFileId('f-2'),
        cloudMtime: 500,
        localMtime: 600,
      });
      expect(store.getFileId('test.md')).toBe('f-2');
    });

    it('markSynced updates last_sync_at', () => {
      const store = getStore();
      store.setFileInfo('sync.md', {
        fileId: asFileId('f-3'),
        cloudMtime: 100,
        localMtime: 100,
      });
      store.markSynced('sync.md', 9999);
      expect(store.getFileInfo('sync.md')!.lastSyncAt).toBe(9999);
    });

    it('removeFileInfo deletes the record', () => {
      const store = getStore();
      store.setFileInfo('del.md', {
        fileId: asFileId('f-4'),
        cloudMtime: 100,
        localMtime: 100,
      });
      store.removeFileInfo('del.md');
      expect(store.getFileInfo('del.md')).toBeNull();
    });
  });
}

function fileInfoAdvancedTests(getStore: () => MetadataStore): void {
  describe('file info advanced', () => {
    it('renamePath migrates metadata', () => {
      const store = getStore();
      store.setFileInfo('old.md', {
        fileId: asFileId('f-5'),
        cloudMtime: 100,
        localMtime: 200,
      });
      const ok = store.renamePath('old.md', 'new.md');
      expect(ok).toBe(true);
      expect(store.getFileInfo('old.md')).toBeNull();
      expect(store.getFileInfo('new.md')!.fileId).toBe('f-5');
    });

    it('findByFileId reverse lookup', () => {
      const store = getStore();
      store.setFileInfo('lookup.md', {
        fileId: asFileId('f-lookup'),
        cloudMtime: 100,
        localMtime: 200,
      });
      expect(store.findByFileId(asFileId('f-lookup'))).toBe('lookup.md');
      expect(store.findByFileId(asFileId('nonexistent'))).toBeNull();
    });

    it('content hash CRUD', () => {
      const store = getStore();
      store.setFileInfo('hash.md', {
        fileId: asFileId('f-h'),
        cloudMtime: 100,
        localMtime: 200,
        contentHash: asContentHash('v1'),
      });
      expect(store.getContentHash('hash.md')).toBe('v1');
      store.updateContentHash('hash.md', asContentHash('v2'));
      expect(store.getContentHash('hash.md')).toBe('v2');
    });
  });
}

function directoryTests(getStore: () => MetadataStore): void {
  describe('directory operations', () => {
    it('directory CRUD', () => {
      const store = getStore();
      store.setDirInfo('my-folder', asDirId('d-100'), asDirId('d-root'));
      expect(store.getDirId('my-folder')).toBe('d-100');
      expect(store.findByDirId(asDirId('d-100'))).toBe('my-folder');
      expect(store.getAllDirs().get('my-folder')?.dirId).toBe('d-100');
      store.removeDir('my-folder');
      expect(store.getDirId('my-folder')).toBeNull();
    });
  });
}

function syncStateTests(getStore: () => MetadataStore): void {
  describe('sync state', () => {
    it('sync state key-value', () => {
      const store = getStore();
      expect(store.getState('k1')).toBeNull();
      store.setState('k1', 'hello');
      expect(store.getState('k1')).toBe('hello');
      expect(store.getStateInt('num', 42)).toBe(42);
      store.setState('num', '123');
      expect(store.getStateInt('num')).toBe(123);
    });

    it('recordSync creates sync log entry', () => {
      const store = getStore();
      store.recordSync('logged.md', {
        fileId: asFileId('f-log'),
        cloudMtime: 300,
        localMtime: 400,
        action: 'download',
        direction: 'pull',
        contentHash: asContentHash('h-new'),
      });
      const info = store.getFileInfo('logged.md');
      expect(info!.fileId).toBe('f-log');
      expect(info!.lastSyncAt).toBeGreaterThan(0);
    });
  });
}

function queriesAndUpsertTests(getStore: () => MetadataStore): void {
  describe('queries and upsert', () => {
    it('getAllFiles returns all records', () => {
      const store = getStore();
      store.setFileInfo('a.md', { fileId: asFileId('fa'), cloudMtime: 1, localMtime: 1 });
      store.setFileInfo('b.md', { fileId: asFileId('fb'), cloudMtime: 2, localMtime: 2 });
      const all = store.getAllFiles();
      expect(all.size).toBe(2);
      expect(all.get('a.md')!.fileId).toBe('fa');
      expect(all.get('b.md')!.fileId).toBe('fb');
    });

    it('upsert preserves existing values via COALESCE', () => {
      const store = getStore();
      store.setFileInfo('coalesce.md', {
        fileId: asFileId('f-c'),
        cloudMtime: 100,
        localMtime: 200,
        parentId: asDirId('d-orig'),
        contentHash: asContentHash('original'),
      });
      store.setFileInfo('coalesce.md', {
        fileId: asFileId('f-c'),
        cloudMtime: 300,
        localMtime: 400,
      });
      const info = store.getFileInfo('coalesce.md');
      expect(info!.cloudMtime).toBe(300);
      expect(info!.localMtime).toBe(400);
      expect(info!.parentId).toBe('d-orig');
      expect(info!.contentHash).toBe('original');
    });
  });
}

function cloudCacheTests(getStore: () => MetadataStore): void {
  describe('cloud cache', () => {
    it('cacheCloudFileInfo sets cloud fields without touching local_mtime', () => {
      const store = getStore();
      store.cacheCloudFileInfo('cached.md', {
        fileId: asFileId('f-cache'),
        cloudMtime: 5000,
        parentId: asDirId('d-p'),
        domain: NoteDomain.NOTE,
      });
      const info = store.getFileInfo('cached.md');
      expect(info).not.toBeNull();
      expect(info!.fileId).toBe('f-cache');
      expect(info!.localMtime).toBe(0);
      expect(info!.cloudMtime).toBe(5000);
    });
  });
}

describe('MetadataStore', () => {
  let store: MetadataStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'meta-test-'));
    store = new MetadataStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const getStore = (): MetadataStore => store;

  fileInfoBasicTests(getStore);
  fileInfoAdvancedTests(getStore);
  directoryTests(getStore);
  syncStateTests(getStore);
  queriesAndUpsertTests(getStore);
  cloudCacheTests(getStore);
});
