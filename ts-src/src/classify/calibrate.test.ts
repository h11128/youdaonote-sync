import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../metadata/store.js';
import { calibrateMetadata } from './calibrate.js';
import type { CloudFile } from '../types/scan.js';
import type { LocalFile } from '../types/scan.js';
import type { ContentHash, DirId, FileId } from '../types/common.js';

const TMP = join(tmpdir(), `calibrate-test-${Date.now()}`);
const DB_PATH = join(TMP, 'meta.db');
let meta: MetadataStore;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  meta = new MetadataStore(DB_PATH);
});

afterEach(() => {
  meta.close();
  rmSync(TMP, { recursive: true, force: true });
});

function makeCloudFile(overrides?: Partial<CloudFile>): CloudFile {
  return {
    id: 'cf1' as FileId,
    name: 'test.md',
    mtime: 1000,
    ctime: 900,
    isDir: false,
    domain: 0,
    parentId: 'root' as DirId,
    ...overrides,
  };
}

function makeLocalFile(overrides?: Partial<LocalFile>): LocalFile {
  return {
    path: join(TMP, 'test.md'),
    mtime: 1000,
    size: 100,
    isDir: false,
    ...overrides,
  };
}

describe('calibrateMetadata: file calibration', () => {
  it('Case2: creates full metadata for file on both sides with no existing metadata', () => {
    const filePath = join(TMP, 'new.md');
    writeFileSync(filePath, 'hello world');

    const cloud = new Map<string, CloudFile>([
      ['new.md', makeCloudFile({ id: 'cf-new' as FileId, name: 'new.md' })],
    ]);
    const local = new Map<string, LocalFile>([['new.md', makeLocalFile({ path: filePath })]]);

    const count = calibrateMetadata(meta, cloud, local, new Map());
    expect(count).toBeGreaterThan(0);

    const info = meta.getFileInfo('new.md');
    expect(info).not.toBeNull();
    expect(info!.fileId).toBe('cf-new');
    expect(info!.cloudMtime).toBe(1000);
    expect(info!.contentHash).not.toBeNull();
    expect(info!.lastSyncAt).toBeGreaterThan(0);
  });

  it('Case1: fills cloudMtime when existing metadata has fileId and localMtime but no cloudMtime', () => {
    meta.setFileInfo('existing.md', {
      fileId: 'f-exist' as FileId,
      cloudMtime: 0,
      localMtime: 500,
    });

    const cloud = new Map<string, CloudFile>([
      [
        'existing.md',
        makeCloudFile({
          id: 'f-exist' as FileId,
          name: 'existing.md',
          mtime: 800,
        }),
      ],
    ]);
    const local = new Map<string, LocalFile>([
      ['existing.md', makeLocalFile({ path: join(TMP, 'existing.md') })],
    ]);

    writeFileSync(join(TMP, 'existing.md'), 'content');

    const count = calibrateMetadata(meta, cloud, local, new Map());
    expect(count).toBeGreaterThan(0);

    const info = meta.getFileInfo('existing.md');
    expect(info!.cloudMtime).toBe(800);
  });

  it('skips files that already have contentHash and lastSyncAt', () => {
    meta.setFileInfo('synced.md', {
      fileId: 'f-s' as FileId,
      cloudMtime: 100,
      localMtime: 100,
    });
    meta.batch(() => {
      meta.updateContentHash('synced.md', 'somehash' as ContentHash);
      meta.markSynced('synced.md');
    });

    const cloud = new Map<string, CloudFile>([
      ['synced.md', makeCloudFile({ id: 'f-s' as FileId, name: 'synced.md' })],
    ]);
    const local = new Map<string, LocalFile>([
      ['synced.md', makeLocalFile({ path: join(TMP, 'synced.md') })],
    ]);
    writeFileSync(join(TMP, 'synced.md'), 'content');

    const count = calibrateMetadata(meta, cloud, local, new Map());
    expect(count).toBe(0);
  });
});

describe('calibrateMetadata: edge cases', () => {
  it('calibrates directory entries', () => {
    const cloud = new Map<string, CloudFile>([
      [
        'mydir',
        makeCloudFile({
          id: 'dir-1' as unknown as FileId,
          name: 'mydir',
          isDir: true,
          parentId: 'root' as DirId,
        }),
      ],
    ]);

    const count = calibrateMetadata(meta, cloud, new Map(), new Map());
    expect(count).toBe(1);
    expect(meta.getDirId('mydir')).toBe('dir-1');
  });

  it('skips files only on one side', () => {
    const cloud = new Map<string, CloudFile>([
      ['cloud-only.md', makeCloudFile({ name: 'cloud-only.md' })],
    ]);
    const local = new Map<string, LocalFile>();

    const count = calibrateMetadata(meta, cloud, local, new Map());
    expect(count).toBe(0);
  });

  it('uses pre-computed hash from localHashes map', () => {
    const filePath = join(TMP, 'hashed.md');
    writeFileSync(filePath, 'some content');

    const preHash = 'precomputed-hash-value' as ContentHash;
    const localHashes = new Map<string, ContentHash | null>([['hashed.md', preHash]]);

    const cloud = new Map<string, CloudFile>([
      ['hashed.md', makeCloudFile({ id: 'cf-h' as FileId, name: 'hashed.md' })],
    ]);
    const local = new Map<string, LocalFile>([['hashed.md', makeLocalFile({ path: filePath })]]);

    calibrateMetadata(meta, cloud, local, localHashes);

    const info = meta.getFileInfo('hashed.md');
    expect(info!.contentHash).toBe(preHash);
  });
});
