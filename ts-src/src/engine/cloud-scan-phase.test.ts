/**
 * cloud-scan-phase: exclude must run before saveScanVersion.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../metadata/store.js';
import { asDirId, asEpochSeconds, asFileId, asRelPath, NoteDomain } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { YoudaoNoteApi } from '../api/client.js';
import { runCloudScanPhase } from './cloud-scan-phase.js';

vi.mock('../scan/cloud.js', () => ({
  scanCloud: vi.fn(),
}));

vi.mock('../scan/cloud-cache.js', async () => {
  const actual = await vi.importActual('../scan/cloud-cache.js');
  return {
    ...actual,
    tryCachedCloudScan: vi.fn().mockResolvedValue(null),
    fetchCurrentVersion: vi.fn().mockResolvedValue(42),
  };
});

import { scanCloud } from '../scan/cloud.js';

function mockApi(): YoudaoNoteApi {
  return { listRecent: vi.fn() } as unknown as YoudaoNoteApi;
}

describe('runCloudScanPhase exclude-before-save', () => {
  let tmpDir = '';
  let meta: MetadataStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cloud-scan-phase-'));
    meta = new MetadataStore(join(tmpDir, 'meta.db'));
  });

  afterEach(() => {
    meta.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not persist excluded paths via saveScanVersion', async () => {
    const keep: CloudFile = {
      id: asFileId('f-keep'),
      name: 'keep.md',
      mtime: asEpochSeconds(10),
      ctime: asEpochSeconds(10),
      isDir: false,
      domain: NoteDomain.MARKDOWN,
      parentId: asDirId('root'),
    };
    const drop: CloudFile = {
      id: asFileId('f-drop'),
      name: 'skip.db',
      mtime: asEpochSeconds(10),
      ctime: asEpochSeconds(10),
      isDir: false,
      domain: NoteDomain.MARKDOWN,
      parentId: asDirId('root'),
    };
    vi.mocked(scanCloud).mockResolvedValue(
      new Map([
        [asRelPath('keep.md'), keep],
        [asRelPath('skip.db'), drop],
      ]),
    );

    const { cloudSnap, didFullScan } = await runCloudScanPhase({
      api: mockApi(),
      meta,
      rootDirId: asDirId('root'),
      skipDesktopSeed: true,
      dryRun: false,
      syncExclude: ['*.db'],
    });

    expect(didFullScan).toBe(true);
    expect(cloudSnap.has(asRelPath('keep.md'))).toBe(true);
    expect(cloudSnap.has(asRelPath('skip.db'))).toBe(false);
    expect(meta.getFileInfo(asRelPath('keep.md'))?.fileId).toBe('f-keep');
    expect(meta.getFileInfo(asRelPath('skip.db'))).toBeNull();
  });
});
