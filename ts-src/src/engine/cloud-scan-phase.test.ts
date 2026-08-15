import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../metadata/store.js';
import { asDirId, asEpochSeconds, asFileId, asRelPath, NoteDomain } from '../types/common.js';
import type { RelPath } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { replaceCloudSnapFromLiveScan } from './cloud-scan-phase.js';
import { saveScanVersion } from '../scan/cloud-cache.js';

const TMP = join(tmpdir(), 'cloud-scan-phase-test');

function keepFile(): CloudFile {
  return {
    id: asFileId('keep'),
    parentId: asDirId('root'),
    name: 'keep.md',
    isDir: false,
    mtime: asEpochSeconds(1),
    ctime: asEpochSeconds(1),
    domain: NoteDomain.MARKDOWN,
  };
}

function seededSnap(n: number): Map<RelPath, CloudFile> {
  const cloudSnap = new Map<RelPath, CloudFile>();
  for (let i = 1; i <= n; i++) {
    cloudSnap.set(asRelPath(`f${i}.md`), {
      ...keepFile(),
      id: asFileId(`f${i}`),
      name: `f${i}.md`,
    });
  }
  return cloudSnap;
}

function rootPlusBrokenDiary(rootFiles: { id: string; name: string }[]) {
  return {
    getDirInfoById: (id: string) => {
      if (id === 'root') {
        return Promise.resolve({
          entries: [
            ...rootFiles.map((f) => ({ fileEntry: { ...f, dir: false } })),
            { fileEntry: { id: 'dir-diary', name: '日记', dir: true } },
          ],
        });
      }
      return Promise.reject(new Error('diary list failed'));
    },
  };
}

describe('replaceCloudSnapFromLiveScan', () => {
  let meta: MetadataStore;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    meta = new MetadataStore(join(TMP, 'meta.db'));
  });

  afterEach(() => {
    meta.close();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('does not clear or save when the live root listing fails', async () => {
    const cloudSnap = new Map<RelPath, CloudFile>([[asRelPath('keep.md'), keepFile()]]);
    saveScanVersion(meta, cloudSnap, 10);
    await expect(
      replaceCloudSnapFromLiveScan({
        api: { getDirInfoById: () => Promise.reject(new Error('network')) },
        meta,
        cloudSnap,
        rootDirId: asDirId('root'),
      }),
    ).rejects.toThrow('network');
    expect(cloudSnap.get(asRelPath('keep.md'))?.id).toBe('keep');
    expect(meta.getFileInfo(asRelPath('keep.md'))?.fileId).toBe('keep');
  });

  it('does not clear or save an empty live snap', async () => {
    const cloudSnap = new Map<RelPath, CloudFile>([[asRelPath('keep.md'), keepFile()]]);
    saveScanVersion(meta, cloudSnap, 10);
    await expect(
      replaceCloudSnapFromLiveScan({
        api: { getDirInfoById: () => Promise.resolve({ entries: [] }) },
        meta,
        cloudSnap,
        rootDirId: asDirId('root'),
      }),
    ).rejects.toThrow('full-scan fallback refused');
    expect(cloudSnap.get(asRelPath('keep.md'))?.id).toBe('keep');
    expect(meta.getFileInfo(asRelPath('keep.md'))?.fileId).toBe('keep');
  });
});

describe('replaceCloudSnapFromLiveScan: subtree list failure', () => {
  let meta: MetadataStore;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    meta = new MetadataStore(join(TMP, 'meta.db'));
  });

  afterEach(() => {
    meta.close();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('does not replace a large cache with a truncated live listing', async () => {
    const cloudSnap = seededSnap(5);
    saveScanVersion(meta, cloudSnap, 10);
    await expect(
      replaceCloudSnapFromLiveScan({
        api: rootPlusBrokenDiary([{ id: 'keep', name: 'keep.md' }]),
        meta,
        cloudSnap,
        rootDirId: asDirId('root'),
      }),
    ).rejects.toThrow('diary list failed');
    expect(cloudSnap.size).toBe(5);
    expect(meta.getFileInfo(asRelPath('f1.md'))?.fileId).toBe('f1');
  });

  it('does not replace when a minority subtree listing fails', async () => {
    const cloudSnap = seededSnap(10);
    saveScanVersion(meta, cloudSnap, 10);
    const rootFiles = Array.from({ length: 9 }, (_, i) => ({
      id: `f${i + 1}`,
      name: `f${i + 1}.md`,
    }));
    await expect(
      replaceCloudSnapFromLiveScan({
        api: rootPlusBrokenDiary(rootFiles),
        meta,
        cloudSnap,
        rootDirId: asDirId('root'),
      }),
    ).rejects.toThrow('diary list failed');
    expect(cloudSnap.size).toBe(10);
  });
});
