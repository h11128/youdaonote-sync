/* eslint-disable max-lines-per-function, @typescript-eslint/no-empty-function */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SyncEngine } from './engine.js';
import type { YoudaoNoteApi } from '../api/client.js';
import { asDirId, asRelPath, asEpochSeconds } from '../types/common.js';
import type { DirInfoByIdResponse } from '../types/dir.js';
import { logger } from '../util/logger.js';
import type { MetadataStore } from '../metadata/store.js';

describe('SyncEngine Guardrails', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'engine-guardrail-test-'));
    vi.spyOn(logger, 'error');
    vi.spyOn(logger, 'warn');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('aborts sync if cloud returns empty list but local has many cloud-linked files', async () => {
    const mockApi = {
      loginByCookies: () => null,
      getRootId: () => Promise.resolve(asDirId('root')),
      getDirInfoById: () => Promise.resolve({ entries: [] } as DirInfoByIdResponse),
      listRecent: () => Promise.resolve([]),
    } as unknown as YoudaoNoteApi;

    const linked = new Map();
    for (let i = 0; i < 8; i++) {
      linked.set(asRelPath(`tracked${i}.md`), {
        fileId: `id${i}`,
        cloudMtime: asEpochSeconds(100),
        localMtime: asEpochSeconds(100),
        lastSyncAt: asEpochSeconds(100),
      });
    }

    const mockMeta = {
      getState: () => null,
      setState: () => {},
      getStateInt: () => 0,
      hasEmptyFileId: () => false,
      getAllFiles: () => linked,
      getFileInfo: () => null,
      save: () => {},
      batch: (fn: any) => fn(),
      getCachedHashesBulk: () => new Map(),
      setCachedHashesBulk: () => {},
      getStaleCloudPaths: () => [],
      getStaleFilePaths: () => [],
      getAllDirPaths: () => [],
      deleteSyncLogBefore: () => 0,
      getAllBaseContentPaths: () => [],
      getAllFileRefs: () => new Map(),
      close: () => {},
    } as unknown as MetadataStore;

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: '',
      localDir: tmpDir,
      dryRun: false,
      api: mockApi,
      meta: mockMeta,
      maxDeletesPerSync: 5,
    });

    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(tmpDir, 'local.md'), 'content');

    const result = await engine.sync();

    expect(result.stats.downloaded).toBe(0);
    expect(result.status).toBe('aborted');
    expect(result.reason).toBe('empty_cloud_response');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Cloud returned empty list'));
  });

  it('aborts sync if delete threshold is exceeded', async () => {
    const mockApi = {
      loginByCookies: () => null,
      getRootId: () => Promise.resolve(asDirId('root')),
      getDirInfoById: () => Promise.resolve({ entries: [] } as DirInfoByIdResponse),
    } as unknown as YoudaoNoteApi;

    const mockFiles = new Map();
    for (let i = 0; i < 10; i++) {
      mockFiles.set(asRelPath(`file${i}.md`), {
        fileId: `id${i}`,
        cloudMtime: asEpochSeconds(100),
        localMtime: asEpochSeconds(100),
        lastSyncAt: asEpochSeconds(100),
      });
    }

    const mockMeta = {
      getState: () => null,
      setState: () => {},
      getStateInt: () => 0,
      hasEmptyFileId: () => false,
      getAllFiles: () => mockFiles,
      save: () => {},
      batch: (fn: any) => fn(),
      getCachedHashesBulk: () => new Map(),
      setCachedHashesBulk: () => {},
      getStaleCloudPaths: () => [],
      getStaleFilePaths: () => [],
      getAllDirPaths: () => [],
      deleteSyncLogBefore: () => 0,
      getAllBaseContentPaths: () => [],
      getAllFileRefs: () => new Map(),
      close: () => {},
    } as unknown as MetadataStore;

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: '',
      localDir: tmpDir,
      dryRun: false,
      api: mockApi,
      meta: mockMeta,
      maxDeletesPerSync: 5,
      propagateDeletes: true,
    });

    // We need cloudSnap to have these files to trigger localDeleted (cloud exists, local doesn't)
    const mockCloudSnap = new Map();
    for (let i = 0; i < 10; i++) {
      mockCloudSnap.set(asRelPath(`file${i}.md`), {
        id: `id${i}`,
        name: `file${i}.md`,
        mtime: asEpochSeconds(100), // Equal to meta.cloudMtime -> cloudMtimeChanged: false
        isDir: false,
      });
    }
    // Override scanCloudPhase to return our mock cloudSnap
    (engine as any).scanCloudPhase = vi.fn().mockResolvedValue({
      cloudSnap: mockCloudSnap,
      didFullScan: true,
    });
    // Override scanLocalPhase to return empty localSnap
    (engine as any).scanLocalPhase = vi.fn().mockResolvedValue({
      localSnap: new Map(),
      localHashes: new Map(),
    });

    const result = await engine.sync();

    expect(result.stats.deletedLocal).toBe(0);
    expect(result.status).toBe('suspended');
    expect(result.reason).toBe('delete_threshold');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Threshold exceeded: 10 deletes, limit 5'),
    );
  });
});
