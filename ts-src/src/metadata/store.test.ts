import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MetadataStore } from './store.js';
import {
  asFileId,
  asDirId,
  asContentHash,
  asRelPath,
  asEpochSeconds,
  NoteDomain,
} from '../types/common.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function fileInfoBasicTests(getStore: () => MetadataStore): void {
  describe('file info basic', () => {
    it('setFileInfo + getFileInfo round-trip', () => {
      const store = getStore();
      store.setFileInfo(asRelPath('notes/hello.md'), {
        fileId: asFileId('f-1'),
        cloudMtime: asEpochSeconds(1000),
        localMtime: asEpochSeconds(2000),
        parentId: asDirId('d-1'),
        domain: NoteDomain.MARKDOWN,
        contentHash: asContentHash('hash-abc'),
      });
      const info = store.getFileInfo(asRelPath('notes/hello.md'));
      expect(info).not.toBeNull();
      expect(info!.fileId).toBe('f-1');
      expect(info!.cloudMtime).toBe(1000);
      expect(info!.localMtime).toBe(2000);
      expect(info!.parentId).toBe('d-1');
      expect(info!.domain).toBe(NoteDomain.MARKDOWN);
      expect(info!.contentHash).toBe('hash-abc');
    });

    it('getFileInfo returns null for non-existent path', () => {
      expect(getStore().getFileInfo(asRelPath('nonexistent.md'))).toBeNull();
    });

    it('getFileId returns the file ID', () => {
      const store = getStore();
      store.setFileInfo(asRelPath('test.md'), {
        fileId: asFileId('f-2'),
        cloudMtime: asEpochSeconds(500),
        localMtime: asEpochSeconds(600),
      });
      expect(store.getFileId(asRelPath('test.md'))).toBe('f-2');
    });

    it('markSynced updates last_sync_at', () => {
      const store = getStore();
      store.setFileInfo(asRelPath('sync.md'), {
        fileId: asFileId('f-3'),
        cloudMtime: asEpochSeconds(100),
        localMtime: asEpochSeconds(100),
      });
      store.markSynced(asRelPath('sync.md'), asEpochSeconds(9999));
      expect(store.getFileInfo(asRelPath('sync.md'))!.lastSyncAt).toBe(9999);
    });

    it('removeFileInfo deletes the record', () => {
      const store = getStore();
      store.setFileInfo(asRelPath('del.md'), {
        fileId: asFileId('f-4'),
        cloudMtime: asEpochSeconds(100),
        localMtime: asEpochSeconds(100),
      });
      store.removeFileInfo(asRelPath('del.md'));
      expect(store.getFileInfo(asRelPath('del.md'))).toBeNull();
    });
  });
}

function fileInfoAdvancedTests(getStore: () => MetadataStore): void {
  describe('file info advanced', () => {
    it('renamePath migrates metadata', () => {
      const store = getStore();
      store.setFileInfo(asRelPath('old.md'), {
        fileId: asFileId('f-5'),
        cloudMtime: asEpochSeconds(100),
        localMtime: asEpochSeconds(200),
      });
      const ok = store.renamePath(asRelPath('old.md'), asRelPath('new.md'));
      expect(ok).toBe(true);
      expect(store.getFileInfo(asRelPath('old.md'))).toBeNull();
      expect(store.getFileInfo(asRelPath('new.md'))!.fileId).toBe('f-5');
    });

    it('findByFileId reverse lookup', () => {
      const store = getStore();
      store.setFileInfo(asRelPath('lookup.md'), {
        fileId: asFileId('f-lookup'),
        cloudMtime: asEpochSeconds(100),
        localMtime: asEpochSeconds(200),
      });
      expect(store.findByFileId(asFileId('f-lookup'))).toBe('lookup.md');
      expect(store.findByFileId(asFileId('nonexistent'))).toBeNull();
    });

    it('content hash CRUD', () => {
      const store = getStore();
      store.setFileInfo(asRelPath('hash.md'), {
        fileId: asFileId('f-h'),
        cloudMtime: asEpochSeconds(100),
        localMtime: asEpochSeconds(200),
        contentHash: asContentHash('v1'),
      });
      expect(store.getContentHash(asRelPath('hash.md'))).toBe('v1');
      store.updateContentHash(asRelPath('hash.md'), asContentHash('v2'));
      expect(store.getContentHash(asRelPath('hash.md'))).toBe('v2');
    });
  });
}

function directoryTests(getStore: () => MetadataStore): void {
  describe('directory operations', () => {
    it('directory CRUD', () => {
      const store = getStore();
      store.setDirInfo(asRelPath('my-folder'), asDirId('d-100'), asDirId('d-root'));
      expect(store.getDirId(asRelPath('my-folder'))).toBe('d-100');
      expect(store.findByDirId(asDirId('d-100'))).toBe('my-folder');
      expect(store.getAllDirs().get(asRelPath('my-folder'))?.dirId).toBe('d-100');
      store.removeDir(asRelPath('my-folder'));
      expect(store.getDirId(asRelPath('my-folder'))).toBeNull();
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
      store.recordSync(asRelPath('logged.md'), {
        fileId: asFileId('f-log'),
        cloudMtime: asEpochSeconds(300),
        localMtime: asEpochSeconds(400),
        action: 'download',
        direction: 'pull',
        contentHash: asContentHash('h-new'),
      });
      const info = store.getFileInfo(asRelPath('logged.md'));
      expect(info!.fileId).toBe('f-log');
      expect(info!.lastSyncAt).toBeGreaterThan(0);
    });
  });
}

function queriesAndUpsertTests(getStore: () => MetadataStore): void {
  describe('queries and upsert', () => {
    it('getAllFiles returns all records', () => {
      const store = getStore();
      store.setFileInfo(asRelPath('a.md'), {
        fileId: asFileId('fa'),
        cloudMtime: asEpochSeconds(1),
        localMtime: asEpochSeconds(1),
      });
      store.setFileInfo(asRelPath('b.md'), {
        fileId: asFileId('fb'),
        cloudMtime: asEpochSeconds(2),
        localMtime: asEpochSeconds(2),
      });
      const all = store.getAllFiles();
      expect(all.size).toBe(2);
      expect(all.get(asRelPath('a.md'))!.fileId).toBe('fa');
      expect(all.get(asRelPath('b.md'))!.fileId).toBe('fb');
    });

    it('upsert preserves existing values via COALESCE', () => {
      const store = getStore();
      store.setFileInfo(asRelPath('coalesce.md'), {
        fileId: asFileId('f-c'),
        cloudMtime: asEpochSeconds(100),
        localMtime: asEpochSeconds(200),
        parentId: asDirId('d-orig'),
        contentHash: asContentHash('original'),
      });
      store.setFileInfo(asRelPath('coalesce.md'), {
        fileId: asFileId('f-c'),
        cloudMtime: asEpochSeconds(300),
        localMtime: asEpochSeconds(400),
      });
      const info = store.getFileInfo(asRelPath('coalesce.md'));
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
      store.cacheCloudFileInfo(asRelPath('cached.md'), {
        fileId: asFileId('f-cache'),
        cloudMtime: asEpochSeconds(5000),
        parentId: asDirId('d-p'),
        domain: NoteDomain.NOTE,
      });
      const info = store.getFileInfo(asRelPath('cached.md'));
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
