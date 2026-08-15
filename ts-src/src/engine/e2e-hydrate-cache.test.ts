/**
 * Incremental cache must use the same identity as a live listing:
 * local `.md` + official-app `.note` in the parent folder = one file.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { SyncEngine } from './engine.js';
import { MetadataStore } from '../metadata/store.js';
import { asRelPath } from '../types/common.js';
import type { RelPath } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { saveScanVersion } from '../scan/cloud-cache.js';
import {
  makeCloudEntry,
  buildMockApi,
  setupE2EContext,
  type MockApiRecorder,
} from './e2e-fixtures.js';

describe('E2E: cache snap hydrates official-app .note', () => {
  let localDir = '';
  let metaPath = '';
  let cleanup = (): void => undefined;

  beforeEach(() => {
    const ctx = setupE2EContext();
    localDir = ctx.localDir;
    metaPath = ctx.metaPath;
    cleanup = ctx.cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  it('does not create .md when cache missed a mapped .note', async () => {
    const meta = new MetadataStore(metaPath);
    writeFileSync(join(localDir, 'keep.md'), 'seed');
    writeFileSync(join(localDir, '2026年8月13日.md'), '# local diary');
    const keep: CloudFile = {
      id: 'f-keep' as CloudFile['id'],
      parentId: 'root' as CloudFile['parentId'],
      name: 'keep.md',
      isDir: false,
      mtime: 1000 as CloudFile['mtime'],
      ctime: 900 as CloudFile['ctime'],
      domain: 1 as CloudFile['domain'],
    };
    saveScanVersion(meta, new Map<RelPath, CloudFile>([[asRelPath('keep.md'), keep]]), 10);

    const recorder: MockApiRecorder = { pushed: [], deleted: [], moved: [], dirs: [] };
    const mockApi = buildMockApi(
      [
        makeCloudEntry('f-keep', 'keep.md', 1000),
        makeCloudEntry('WEB-note-813', '2026年8月13日.note', 50, { domain: 0 }),
      ],
      new Map([
        ['f-keep', 'seed'],
        ['WEB-note-813', '# cloud diary'],
      ]),
      recorder,
    );
    const engine = new SyncEngine({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir,
      api: mockApi,
      meta,
      autoGit: false,
    });
    const result = await engine.sync();
    expect(result.stats.errors).toBe(0);
    expect(recorder.pushed.some((p) => p.name.endsWith('.md') && p.isCreate)).toBe(false);
    expect(meta.getFileInfo(asRelPath('2026年8月13日.md'))?.fileId).toBe('WEB-note-813');
    engine.close();
  });
});
