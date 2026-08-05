import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../metadata/store.js';
import { calibrateMetadata } from './calibrate.js';
import type { CloudFile } from '../types/scan.js';
import type { LocalFile } from '../types/scan.js';
import { asEpochSeconds, asRelPath } from '../types/common.js';
import type { ContentHash, DirId, FileId, RelPath } from '../types/common.js';

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
    mtime: asEpochSeconds(1000),
    ctime: asEpochSeconds(900),
    isDir: false,
    domain: 0,
    parentId: 'root' as DirId,
    ...overrides,
  };
}

function makeLocalFile(overrides?: Partial<LocalFile>): LocalFile {
  return {
    path: join(TMP, 'test.md'),
    mtime: asEpochSeconds(1000),
    size: 100,
    isDir: false,
    ...overrides,
  };
}

describe('calibrateMetadata: file calibration', () => {
  it('Case2: creates full metadata for file on both sides with no existing metadata', () => {
    const filePath = join(TMP, 'new.md');
    writeFileSync(filePath, 'hello world');

    const preHash = 'pre-computed-hash' as ContentHash;
    const localHashes = new Map<RelPath, ContentHash | null>([[asRelPath('new.md'), preHash]]);

    const cloud = new Map<RelPath, CloudFile>([
      [asRelPath('new.md'), makeCloudFile({ id: 'cf-new' as FileId, name: 'new.md' })],
    ]);
    const local = new Map<RelPath, LocalFile>([
      [asRelPath('new.md'), makeLocalFile({ path: filePath })],
    ]);

    const count = calibrateMetadata(meta, cloud, local, localHashes);
    expect(count).toBeGreaterThan(0);

    const info = meta.getFileInfo(asRelPath('new.md'));
    expect(info).not.toBeNull();
    expect(info!.fileId).toBe('cf-new');
    expect(info!.cloudMtime).toBe(1000);
    expect(info!.contentHash).toBe(preHash);
    expect(info!.lastSyncAt).toBeGreaterThan(0);
  });

  it('Case1: fills cloudMtime when existing metadata has fileId and localMtime but no cloudMtime', () => {
    meta.setFileInfo(asRelPath('existing.md'), {
      fileId: 'f-exist' as FileId,
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(500),
    });

    const cloud = new Map<RelPath, CloudFile>([
      [
        asRelPath('existing.md'),
        makeCloudFile({
          id: 'f-exist' as FileId,
          name: 'existing.md',
          mtime: asEpochSeconds(800),
        }),
      ],
    ]);
    const local = new Map<RelPath, LocalFile>([
      [asRelPath('existing.md'), makeLocalFile({ path: join(TMP, 'existing.md') })],
    ]);

    writeFileSync(join(TMP, 'existing.md'), 'content');

    const count = calibrateMetadata(meta, cloud, local, new Map());
    expect(count).toBeGreaterThan(0);

    const info = meta.getFileInfo(asRelPath('existing.md'));
    expect(info!.cloudMtime).toBe(800);
  });
});

describe('calibrateMetadata: skip and re-link', () => {
  it('skips files that already have contentHash and lastSyncAt', () => {
    meta.setFileInfo(asRelPath('synced.md'), {
      fileId: 'f-s' as FileId,
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(100),
    });
    meta.batch(() => {
      meta.updateContentHash(asRelPath('synced.md'), 'somehash' as ContentHash);
      meta.markSynced(asRelPath('synced.md'));
    });

    const cloud = new Map<RelPath, CloudFile>([
      [asRelPath('synced.md'), makeCloudFile({ id: 'f-s' as FileId, name: 'synced.md' })],
    ]);
    const local = new Map<RelPath, LocalFile>([
      [asRelPath('synced.md'), makeLocalFile({ path: join(TMP, 'synced.md') })],
    ]);
    writeFileSync(join(TMP, 'synced.md'), 'content');

    const count = calibrateMetadata(meta, cloud, local, new Map());
    expect(count).toBe(0);
  });

  it('re-links empty file_id rows that still have lastSyncAt (false-upload survivors)', () => {
    const filePath = join(TMP, 'broken.md');
    writeFileSync(filePath, 'hello world');
    meta.setFileInfo(asRelPath('broken.md'), {
      fileId: '' as FileId,
      cloudMtime: asEpochSeconds(50),
      localMtime: asEpochSeconds(50),
    });
    meta.batch(() => {
      meta.updateContentHash(asRelPath('broken.md'), 'stale-hash' as ContentHash);
      meta.markSynced(asRelPath('broken.md'));
    });

    const preHash = 'fresh-hash' as ContentHash;
    const localHashes = new Map<RelPath, ContentHash | null>([[asRelPath('broken.md'), preHash]]);
    const cloud = new Map<RelPath, CloudFile>([
      [asRelPath('broken.md'), makeCloudFile({ id: 'cf-fixed' as FileId, name: 'broken.md' })],
    ]);
    const local = new Map<RelPath, LocalFile>([
      [asRelPath('broken.md'), makeLocalFile({ path: filePath })],
    ]);

    const count = calibrateMetadata(meta, cloud, local, localHashes);
    expect(count).toBeGreaterThan(0);
    const info = meta.getFileInfo(asRelPath('broken.md'));
    expect(info!.fileId).toBe('cf-fixed');
  });
});

describe('calibrateMetadata: edge cases', () => {
  it('calibrates directory entries', () => {
    const cloud = new Map<RelPath, CloudFile>([
      [
        asRelPath('mydir'),
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
    expect(meta.getDirId(asRelPath('mydir'))).toBe('dir-1');
  });

  it('skips files only on one side', () => {
    const cloud = new Map<RelPath, CloudFile>([
      [asRelPath('cloud-only.md'), makeCloudFile({ name: 'cloud-only.md' })],
    ]);
    const local = new Map<RelPath, LocalFile>();

    const count = calibrateMetadata(meta, cloud, local, new Map());
    expect(count).toBe(0);
  });

  it('does not calibrate when file exists on both sides but hash is missing from localHashes', () => {
    const filePath = join(TMP, 'no-hash.md');
    writeFileSync(filePath, 'some content');

    const cloud = new Map<RelPath, CloudFile>([
      [asRelPath('no-hash.md'), makeCloudFile({ id: 'cf-nh' as FileId, name: 'no-hash.md' })],
    ]);
    const local = new Map<RelPath, LocalFile>([
      [asRelPath('no-hash.md'), makeLocalFile({ path: filePath })],
    ]);

    const count = calibrateMetadata(meta, cloud, local, new Map());
    expect(count).toBe(0);
    expect(meta.getFileInfo(asRelPath('no-hash.md'))).toBeNull();
  });

  it('uses pre-computed hash from localHashes map', () => {
    const filePath = join(TMP, 'hashed.md');
    writeFileSync(filePath, 'some content');

    const preHash = 'precomputed-hash-value' as ContentHash;
    const localHashes = new Map<RelPath, ContentHash | null>([[asRelPath('hashed.md'), preHash]]);

    const cloud = new Map<RelPath, CloudFile>([
      [asRelPath('hashed.md'), makeCloudFile({ id: 'cf-h' as FileId, name: 'hashed.md' })],
    ]);
    const local = new Map<RelPath, LocalFile>([
      [asRelPath('hashed.md'), makeLocalFile({ path: filePath })],
    ]);

    calibrateMetadata(meta, cloud, local, localHashes);

    const info = meta.getFileInfo(asRelPath('hashed.md'));
    expect(info!.contentHash).toBe(preHash);
  });
});
