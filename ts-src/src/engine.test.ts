import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SyncEngine } from './engine.js';
import type { YoudaoNoteApi } from './api/client.js';
import { asDirId } from './types/common.js';
import type { DirInfoByIdResponse } from './types/dir.js';

describe('SyncEngine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'engine-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses injected api and meta when provided (dryRun path)', async () => {
    const mockApi: YoudaoNoteApi = {
      loginByCookies: () => null,
      getRootId: async () => asDirId('injected-root'),
      getDirInfoById: async () => ({ entries: [] } as DirInfoByIdResponse),
    } as YoudaoNoteApi;

    const metaPath = join(tmpDir, 'meta.db');
    const { MetadataStore } = await import('./metadata/store.js');
    const meta = new MetadataStore(metaPath);

    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir: tmpDir,
      dryRun: true,
      api: mockApi,
      meta,
    });

    const result = await engine.sync();

    expect(result.stats).toBeDefined();
    expect(result.classified).toBeInstanceOf(Map);
    expect(Object.isFrozen(result.stats)).toBe(true);
    engine.close();
  });
});
