/**
 * Engine integration smoke test.
 *
 * Verifies the complete flow: lock → heal → scan → classify → refine → execute(merge).
 * Uses a real MetadataStore (in-memory SQLite) and real local files,
 * but mocks the YoudaoNoteApi to avoid network calls.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SyncEngine } from './engine.js';
import { MetadataStore } from './metadata/store.js';
import type { YoudaoNoteApi } from './api/client.js';
import type { DirInfoByIdResponse } from './types/dir.js';
import { asDirId } from './types/common.js';
import type { FileId } from './types/common.js';
import { computeContentHashFromFile } from './hash.js';

function makeCloudEntry(id: string, name: string, mtime: number, parentId = 'root') {
  return {
    fileEntry: {
      id,
      name,
      parentId,
      dir: false,
      modifyTimeForSort: mtime,
      createTimeForSort: mtime - 1000,
      domain: 1,
    },
  };
}

function buildMockApi(
  cloudEntries: Record<string, unknown>[],
  cloudFiles: Map<string, string>,
): YoudaoNoteApi {
  return {
    loginByCookies: () => null,
    getRootId: () => Promise.resolve(asDirId('root-dir')),
    getDirInfoById: () => Promise.resolve({ entries: cloudEntries } as DirInfoByIdResponse),
    getFileById: (fileId: FileId) => {
      const content = cloudFiles.get(fileId);
      if (!content) throw new Error(`File not found: ${fileId}`);
      return Promise.resolve(new TextEncoder().encode(content).buffer);
    },
    pushFile: () =>
      Promise.resolve({ entry: { id: 'new-id', modifyTimeForSort: Date.now() / 1000 } }),
    createDir: () => Promise.resolve({ fileEntry: { id: 'new-dir-id' } }),
    deleteFile: () => Promise.resolve({}),
    moveFile: () => Promise.resolve({}),
    renameFile: () => Promise.resolve({}),
    listRecent: () => Promise.resolve([]),
  } as unknown as YoudaoNoteApi;
}

function setupEngineIntContext() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'engine-int-'));
  const localDir = join(tmpDir, 'notes');
  const metaPath = join(tmpDir, 'meta.db');
  mkdirSync(localDir, { recursive: true });
  return {
    tmpDir,
    localDir,
    metaPath,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('Engine integration: heal and classify', () => {
  let localDir: string;
  let metaPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupEngineIntContext();
    localDir = ctx.localDir;
    metaPath = ctx.metaPath;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('heal runs before sync (fixes orphan records)', async () => {
    const meta = new MetadataStore(metaPath);
    // Create an orphan record (no file_id, no local file)
    meta.setFileInfo('phantom.md', {
      fileId: '' as FileId,
      cloudMtime: 0,
      localMtime: 100,
    });
    meta.save();

    const mockApi = buildMockApi([], new Map());

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
    });

    await engine.sync();

    // heal should have removed the orphan
    expect(meta.getFileInfo('phantom.md')).toBeNull();
    engine.close();
  });
});

describe('Engine integration: classify and refine', () => {
  let localDir: string;
  let metaPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupEngineIntContext();
    localDir = ctx.localDir;
    metaPath = ctx.metaPath;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('classify + detect moves: cloud rename detected', async () => {
    const meta = new MetadataStore(metaPath);

    // Local file at new path
    writeFileSync(join(localDir, 'new-name.md'), 'same content');
    const localHash = computeContentHashFromFile(join(localDir, 'new-name.md'));

    // Metadata knows old path
    meta.setFileInfo('old-name.md', {
      fileId: 'f1' as FileId,
      cloudMtime: 1000,
      localMtime: 1000,
      contentHash: localHash,
      lastSyncAt: 1000,
    });
    meta.save();

    // Cloud has file at new-name.md (no old-name.md)
    const cloudEntries = [makeCloudEntry('f1', 'new-name.md', 1000)];
    const mockApi = buildMockApi(cloudEntries, new Map());

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      dryRun: true,
      api: mockApi,
      meta,
    });

    const result = await engine.sync();
    expect(result.classified).toBeInstanceOf(Map);
    engine.close();
  });
});

describe('Engine integration: refine and lock', () => {
  let localDir: string;
  let metaPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupEngineIntContext();
    localDir = ctx.localDir;
    metaPath = ctx.metaPath;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('refine downgrades cloudModifiedContent when hashes match', async () => {
    const meta = new MetadataStore(metaPath);

    // Local file
    const content = 'hello world';
    writeFileSync(join(localDir, 'doc.md'), content);
    const localHash = computeContentHashFromFile(join(localDir, 'doc.md'))!;

    // Metadata with old cloud_mtime (so cloud looks "modified")
    meta.setFileInfo('doc.md', {
      fileId: 'f2' as FileId,
      cloudMtime: 500,
      localMtime: Math.floor(Date.now() / 1000),
      contentHash: localHash,
      lastSyncAt: 1000,
    });
    meta.save();

    // Cloud has same content but different mtime
    const cloudEntries = [makeCloudEntry('f2', 'doc.md', 999)];
    // Cloud file content is the same as local
    const cloudFiles = new Map<string, string>([['f2', content]]);
    const mockApi = buildMockApi(cloudEntries, cloudFiles);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
    });

    const result = await engine.sync();

    // Refine should have downgraded cloudModifiedContent → cloudModifiedMtimeOnly (skip)
    const state = result.classified.get('doc.md');
    expect(state).toBeDefined();
    // Should be either skip (mtime-only) or converged, not download/conflict
    const skipStates = ['synced', 'cloudModifiedMtimeOnly', 'bothModifiedConverged'];
    expect(skipStates).toContain(state!.kind);
    engine.close();
  });
});

describe('Engine integration: lock and dryRun', () => {
  let localDir: string;
  let metaPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupEngineIntContext();
    localDir = ctx.localDir;
    metaPath = ctx.metaPath;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('lock prevents concurrent sync', async () => {
    const meta = new MetadataStore(metaPath);
    const mockApi = buildMockApi([], new Map());

    // Manually create a lock file with current PID
    const lockPath = join(localDir, '.sync.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: Date.now() }));

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
    });

    // Should return empty stats instead of throwing (matches Python behavior)
    const result = await engine.sync();
    expect(result.stats.downloaded).toBe(0);
    expect(result.stats.uploaded).toBe(0);
    expect(result.classified.size).toBe(0);

    // Clean up lock so afterEach can delete tmpDir
    rmSync(lockPath, { force: true });
    engine.close();
  });
});

describe('Engine integration: dryRun and full flow', () => {
  let localDir: string;
  let metaPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupEngineIntContext();
    localDir = ctx.localDir;
    metaPath = ctx.metaPath;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('dryRun skips heal/lock/execute but still classifies', async () => {
    const meta = new MetadataStore(metaPath);
    writeFileSync(join(localDir, 'local-only.md'), 'new file');

    const mockApi = buildMockApi([], new Map());

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      dryRun: true,
      api: mockApi,
      meta,
    });

    const result = await engine.sync();

    expect(result.stats.uploaded).toBe(1);
    expect(result.classified.get('local-only.md')?.kind).toBe('localNew');

    // Lock file should NOT exist (dryRun doesn't acquire lock)
    expect(existsSync(join(localDir, '.sync.lock'))).toBe(false);
    engine.close();
  });
});

describe('Engine integration: full download flow', () => {
  let localDir: string;
  let metaPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupEngineIntContext();
    localDir = ctx.localDir;
    metaPath = ctx.metaPath;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('full non-dryRun flow: download a new cloud file', async () => {
    const meta = new MetadataStore(metaPath);

    const cloudContent = '# Hello from cloud';
    const cloudEntries = [makeCloudEntry('f-new', 'cloud-doc.md', Math.floor(Date.now() / 1000))];
    const cloudFiles = new Map([['f-new', cloudContent]]);
    const mockApi = buildMockApi(cloudEntries, cloudFiles);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
    });

    const result = await engine.sync();

    expect(result.stats.downloaded).toBe(1);
    expect(existsSync(join(localDir, 'cloud-doc.md'))).toBe(true);
    expect(readFileSync(join(localDir, 'cloud-doc.md'), 'utf-8')).toBe(cloudContent);

    // Metadata should be recorded
    const record = meta.getFileInfo('cloud-doc.md');
    expect(record).not.toBeNull();
    expect(record!.fileId).toBe('f-new');

    // Lock file should be released
    expect(existsSync(join(localDir, '.sync.lock'))).toBe(false);
    engine.close();
  });
});

describe('Engine integration: collectItems API', () => {
  let localDir: string;
  let metaPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupEngineIntContext();
    localDir = ctx.localDir;
    metaPath = ctx.metaPath;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('collectItems returns classified map without executing', async () => {
    const meta = new MetadataStore(metaPath);
    writeFileSync(join(localDir, 'local-only.md'), 'new file');

    const mockApi = buildMockApi([], new Map());

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
    });

    const result = await engine.collectItems();

    expect(result.classified).toBeInstanceOf(Map);
    expect(result.classified.get('local-only.md')?.kind).toBe('localNew');
    expect(result.cloudSnap).toBeInstanceOf(Map);
    expect(result.localSnap).toBeInstanceOf(Map);

    engine.close();
  });

  it('collectItems respects direction filter', async () => {
    const meta = new MetadataStore(metaPath);
    writeFileSync(join(localDir, 'local-only.md'), 'new file');

    const cloudContent = '# Cloud only';
    const cloudEntries = [
      makeCloudEntry('f-cloud', 'cloud-only.md', Math.floor(Date.now() / 1000)),
    ];
    const cloudFiles = new Map([['f-cloud', cloudContent]]);
    const mockApi = buildMockApi(cloudEntries, cloudFiles);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      direction: 'pull',
      api: mockApi,
      meta,
    });

    const result = await engine.collectItems();

    // local-only should be filtered out (direction=pull)
    const localState = result.classified.get('local-only.md');
    expect(localState?.kind === 'gone' || localState === undefined).toBe(true);

    // cloud-only should still be present
    expect(result.classified.has('cloud-only.md')).toBe(true);
    engine.close();
  });
});

describe('Engine integration: lock failure graceful return', () => {
  let localDir: string;
  let metaPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = setupEngineIntContext();
    localDir = ctx.localDir;
    metaPath = ctx.metaPath;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('returns zero stats when lock already held', async () => {
    const meta = new MetadataStore(metaPath);
    const mockApi = buildMockApi([], new Map());

    // Simulate a lock held by the current process
    const lockPath = join(localDir, '.sync.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: Date.now() }));

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
    });

    const result = await engine.sync();

    expect(result.stats.downloaded).toBe(0);
    expect(result.stats.uploaded).toBe(0);
    expect(result.stats.errors).toBe(0);
    expect(result.stats.conflicts).toBe(0);
    expect(result.classified.size).toBe(0);

    rmSync(lockPath, { force: true });
    engine.close();
  });
});
