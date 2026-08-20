import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from './store.js';
import { healCloudMtimeBaseline } from './heal-cloud-mtime.js';
import {
  asDirId,
  asEpochSeconds,
  asFileId,
  asRelPath,
  NoteDomain,
  type RelPath,
} from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { classifyAll } from '../classify/classify.js';
import { saveScanVersion } from '../scan/cloud-cache.js';

const TMP = join(tmpdir(), 'heal-cloud-mtime-test');

function cloudFile(id: string, mtime: number): CloudFile {
  return {
    id: asFileId(id),
    parentId: asDirId('root'),
    name: 'doc.md',
    isDir: false,
    mtime: asEpochSeconds(mtime),
    ctime: asEpochSeconds(1),
    domain: NoteDomain.MARKDOWN,
  };
}

describe('healCloudMtimeBaseline', () => {
  let meta: MetadataStore;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    meta = new MetadataStore(join(TMP, 'meta.db'));
  });

  afterEach(() => {
    meta.close();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('refreshes cloud_mtime when file_id relinks', () => {
    const path = asRelPath('doc.md');
    meta.setFileInfo(path, {
      fileId: asFileId('f-old'),
      cloudMtime: asEpochSeconds(1000),
      localMtime: asEpochSeconds(900),
      lastSyncAt: asEpochSeconds(800),
    });
    const cloudSnap = new Map<RelPath, CloudFile>([[path, cloudFile('f-new', 5000)]]);

    const stats = healCloudMtimeBaseline(meta, cloudSnap, true);
    const info = meta.getFileInfo(path);

    expect(stats.fileIdRelink).toBe(1);
    expect(info!.fileId).toBe('f-new');
    expect(info!.cloudMtime).toBe(5000);
  });

  it('clamps baseline when meta.cloudMtime is ahead of live cloud mtime', () => {
    const path = asRelPath('doc.md');
    meta.setFileInfo(path, {
      fileId: asFileId('f-1'),
      cloudMtime: asEpochSeconds(9000),
      localMtime: asEpochSeconds(900),
      lastSyncAt: asEpochSeconds(800),
    });
    const cloudSnap = new Map<RelPath, CloudFile>([[path, cloudFile('f-1', 2000)]]);

    const stats = healCloudMtimeBaseline(meta, cloudSnap, true);

    expect(stats.baselineAhead).toBe(1);
    expect(meta.getFileInfo(path)!.cloudMtime).toBe(2000);
  });

  it('does not write when autoFix is false', () => {
    const path = asRelPath('doc.md');
    meta.setFileInfo(path, {
      fileId: asFileId('f-1'),
      cloudMtime: asEpochSeconds(9000),
      localMtime: asEpochSeconds(900),
      lastSyncAt: asEpochSeconds(800),
    });
    const cloudSnap = new Map<RelPath, CloudFile>([[path, cloudFile('f-1', 2000)]]);

    const stats = healCloudMtimeBaseline(meta, cloudSnap, false);

    expect(stats.baselineAhead).toBe(1);
    expect(meta.getFileInfo(path)!.cloudMtime).toBe(9000);
  });

  it('skips unsynced rows', () => {
    const path = asRelPath('doc.md');
    meta.setFileInfo(path, {
      fileId: asFileId('f-1'),
      cloudMtime: asEpochSeconds(9000),
      localMtime: asEpochSeconds(900),
      lastSyncAt: asEpochSeconds(0),
    });
    const cloudSnap = new Map<RelPath, CloudFile>([[path, cloudFile('f-1', 2000)]]);

    const stats = healCloudMtimeBaseline(meta, cloudSnap, true);

    expect(stats.baselineAhead).toBe(0);
    expect(meta.getFileInfo(path)!.cloudMtime).toBe(9000);
  });
});

describe('saveScanVersion + classify cloud_mtime baseline', () => {
  let meta: MetadataStore;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    meta = new MetadataStore(join(TMP, 'meta-classify.db'));
  });

  afterEach(() => {
    meta.close();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('preserves baseline so classify detects cloud mtime change after scan', () => {
    const path = asRelPath('doc.md');
    const baseline = 1000;
    const liveCloud = 5000;

    meta.setFileInfo(path, {
      fileId: asFileId('f-1'),
      cloudMtime: asEpochSeconds(baseline),
      localMtime: asEpochSeconds(900),
      lastSyncAt: asEpochSeconds(800),
      contentHash: 'old-hash' as never,
    });

    const cloudSnap = new Map<RelPath, CloudFile>([[path, cloudFile('f-1', liveCloud)]]);
    saveScanVersion(meta, cloudSnap, 10);

    expect(meta.getFileInfo(path)!.cloudMtime).toBe(baseline);

    const localSnap = new Map([
      [
        path,
        {
          path: join(TMP, 'doc.md'),
          relPath: path,
          mtime: asEpochSeconds(900),
          size: 10,
          isDir: false,
        },
      ],
    ] as const);
    const localHashes = new Map([[path, 'local-new' as never]]);

    const { classified } = classifyAll(cloudSnap, localSnap, meta.getAllFiles(), localHashes);
    expect(classified.get(path)?.kind).toBe('conflict');
  });
});
