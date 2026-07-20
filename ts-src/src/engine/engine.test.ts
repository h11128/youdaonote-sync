import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SyncEngine, collectDeleteOverrides } from './engine.js';
import {
  filterCloudSnap,
  filterByDirection,
  markExcludedAsGone,
  matchesExclude,
  filterMapByExclude,
  purgeExcludedMetadata,
} from './helpers.js';
import { MetadataStore } from '../metadata/store.js';
import type { YoudaoNoteApi } from '../api/client.js';
import { asDirId, asEpochSeconds, asFileId, asRelPath } from '../types/common.js';
import type { NoteDomain, RelPath } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { FileState } from '../types/state.js';
import type { DirInfoByIdResponse } from '../types/dir.js';

describe('SyncEngine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'engine-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses injected api and meta when provided (dryRun path)', async () => {
    const mockApi = {
      loginByCookies: () => null,
      getRootId: () => Promise.resolve(asDirId('injected-root')),
      getDirInfoById: () => Promise.resolve({ entries: [] } as DirInfoByIdResponse),
    } as unknown as YoudaoNoteApi;

    const metaPath = join(tmpDir, 'meta.db');
    const { MetadataStore } = await import('../metadata/store.js');
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

function fakeCloudFile(name: string): CloudFile {
  return {
    id: asFileId('f-' + name),
    parentId: asDirId('root'),
    name,
    isDir: false,
    mtime: asEpochSeconds(1000),
    ctime: asEpochSeconds(900),
    domain: 0 as NoteDomain,
  };
}

describe('filterCloudSnap', () => {
  it('removes entries matching exclude patterns', () => {
    const snap = new Map<RelPath, CloudFile>([
      [asRelPath('keep.md'), fakeCloudFile('keep.md')],
      [asRelPath('secret.md'), fakeCloudFile('secret.md')],
      [asRelPath('dir/secret-too.md'), fakeCloudFile('secret-too.md')],
    ]);

    filterCloudSnap(snap, { exclude: ['secret*'] });

    expect([...snap.keys()]).toEqual([asRelPath('keep.md')]);
  });

  it('keeps only entries matching include patterns', () => {
    const snap = new Map<RelPath, CloudFile>([
      [asRelPath('notes/a.md'), fakeCloudFile('a.md')],
      [asRelPath('notes/b.txt'), fakeCloudFile('b.txt')],
      [asRelPath('other/c.md'), fakeCloudFile('c.md')],
    ]);

    filterCloudSnap(snap, { include: ['*.md'] });

    expect(snap.has(asRelPath('notes/a.md'))).toBe(true);
    expect(snap.has(asRelPath('other/c.md'))).toBe(true);
    expect(snap.has(asRelPath('notes/b.txt'))).toBe(false);
  });

  it('no-ops when both include and exclude are empty', () => {
    const snap = new Map<RelPath, CloudFile>([[asRelPath('a.md'), fakeCloudFile('a.md')]]);

    filterCloudSnap(snap, {});

    expect(snap.size).toBe(1);
  });

  it('exclude takes precedence over include', () => {
    const snap = new Map<RelPath, CloudFile>([
      [asRelPath('notes/keep.md'), fakeCloudFile('keep.md')],
      [asRelPath('notes/secret.md'), fakeCloudFile('secret.md')],
    ]);

    filterCloudSnap(snap, { include: ['*.md'], exclude: ['secret*'] });

    expect(snap.has(asRelPath('notes/keep.md'))).toBe(true);
    expect(snap.has(asRelPath('notes/secret.md'))).toBe(false);
  });
});

describe('filterByDirection', () => {
  it('pull keeps downloads and conflicts, removes uploads', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('cloud-new.md'), { kind: 'cloudNew' }],
      [asRelPath('local-new.md'), { kind: 'localNew' }],
      [asRelPath('conflict.md'), { kind: 'conflict' }],
      [asRelPath('synced.md'), { kind: 'synced' }],
      [asRelPath('moved.md'), { kind: 'moved', oldPath: asRelPath('old.md') }],
    ]);

    filterByDirection(classified, 'pull');

    expect(classified.get(asRelPath('cloud-new.md'))?.kind).toBe('cloudNew');
    expect(classified.get(asRelPath('conflict.md'))?.kind).toBe('conflict');
    expect(classified.get(asRelPath('local-new.md'))?.kind).toBe('gone');
    expect(classified.get(asRelPath('synced.md'))?.kind).toBe('synced');
    expect(classified.get(asRelPath('moved.md'))?.kind).toBe('moved');
  });

  it('push keeps uploads, removes downloads and conflicts', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('cloud-new.md'), { kind: 'cloudNew' }],
      [asRelPath('local-new.md'), { kind: 'localNew' }],
      [asRelPath('conflict.md'), { kind: 'conflict' }],
      [asRelPath('local-mod.md'), { kind: 'localModified' }],
    ]);

    filterByDirection(classified, 'push');

    expect(classified.get(asRelPath('local-new.md'))?.kind).toBe('localNew');
    expect(classified.get(asRelPath('local-mod.md'))?.kind).toBe('localModified');
    expect(classified.get(asRelPath('cloud-new.md'))?.kind).toBe('gone');
    expect(classified.get(asRelPath('conflict.md'))?.kind).toBe('gone');
  });
});

describe('markExcludedAsGone', () => {
  it('marks excluded paths as gone', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('有道云笔记.md'), { kind: 'localModified' }],
      [asRelPath('notes/ok.md'), { kind: 'localModified' }],
      [asRelPath('visits/__pycache__/x.pyc'), { kind: 'cloudNew' }],
    ]);

    markExcludedAsGone(classified, ['有道云笔记.md', '**/__pycache__/**', '**/*.pyc']);

    expect(classified.get(asRelPath('有道云笔记.md'))?.kind).toBe('gone');
    expect(classified.get(asRelPath('visits/__pycache__/x.pyc'))?.kind).toBe('gone');
    expect(classified.get(asRelPath('notes/ok.md'))?.kind).toBe('localModified');
    expect(matchesExclude('visits/__pycache__/x.pyc', ['**/__pycache__/**'])).toBe(true);
  });
});

describe('filterMapByExclude', () => {
  it('drops excluded paths and keeps others', () => {
    const source = new Map([
      [asRelPath('notes/ok.md'), 1],
      [asRelPath('有道云笔记.md'), 2],
      [asRelPath('visits/__pycache__/x.pyc'), 3],
    ]);

    const filtered = filterMapByExclude(source, {
      exclude: ['有道云笔记.md', '**/__pycache__/**', '**/*.pyc'],
    });

    expect(filtered.has(asRelPath('notes/ok.md'))).toBe(true);
    expect(filtered.has(asRelPath('有道云笔记.md'))).toBe(false);
    expect(filtered.has(asRelPath('visits/__pycache__/x.pyc'))).toBe(false);
  });

  it('returns same map reference when no filters', () => {
    const source = new Map([[asRelPath('a.md'), 1]]);
    expect(filterMapByExclude(source)).toBe(source);
  });

  it('honors include patterns', () => {
    const source = new Map([
      [asRelPath('notes/keep.md'), 1],
      [asRelPath('notes/skip.txt'), 2],
    ]);
    const filtered = filterMapByExclude(source, { include: ['*.md'] });
    expect(filtered.has(asRelPath('notes/keep.md'))).toBe(true);
    expect(filtered.has(asRelPath('notes/skip.txt'))).toBe(false);
  });
});

describe('purgeExcludedMetadata', () => {
  it('removes excluded metadata rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'purge-meta-'));
    const meta = new MetadataStore(join(dir, 'purge-meta.db'));
    try {
      meta.setFileInfo(asRelPath('notes/ok.md'), {
        fileId: asFileId('f-ok'),
        cloudMtime: asEpochSeconds(1),
        localMtime: asEpochSeconds(1),
      });
      meta.setFileInfo(asRelPath('有道云笔记.md'), {
        fileId: asFileId('f-enc'),
        cloudMtime: asEpochSeconds(1),
        localMtime: asEpochSeconds(1),
      });

      const purged = purgeExcludedMetadata(meta, { exclude: ['有道云笔记.md'] });

      expect(purged).toBe(1);
      expect(meta.getFileInfo(asRelPath('有道云笔记.md'))).toBeNull();
      expect(meta.getFileInfo(asRelPath('notes/ok.md'))).not.toBeNull();
    } finally {
      meta.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('collectDeleteOverrides', () => {
  it('maps localDeleted to deleteCloud', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('gone-local.md'), { kind: 'localDeleted' }],
    ]);

    const overrides = collectDeleteOverrides(classified);

    expect(overrides.get(asRelPath('gone-local.md'))).toBe('deleteCloud');
  });

  it('maps cloudDeleted to deleteLocal', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('gone-cloud.md'), { kind: 'cloudDeleted' }],
    ]);

    const overrides = collectDeleteOverrides(classified);

    expect(overrides.get(asRelPath('gone-cloud.md'))).toBe('deleteLocal');
  });

  it('ignores non-deleted states', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('synced.md'), { kind: 'synced' }],
      [asRelPath('new.md'), { kind: 'localNew' }],
      [asRelPath('conflict.md'), { kind: 'conflict' }],
    ]);

    const overrides = collectDeleteOverrides(classified);

    expect(overrides.size).toBe(0);
  });

  it('handles mixed entries correctly', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('a.md'), { kind: 'localDeleted' }],
      [asRelPath('b.md'), { kind: 'cloudDeleted' }],
      [asRelPath('c.md'), { kind: 'synced' }],
      [asRelPath('d.md'), { kind: 'localNew' }],
    ]);

    const overrides = collectDeleteOverrides(classified);

    expect(overrides.size).toBe(2);
    expect(overrides.get(asRelPath('a.md'))).toBe('deleteCloud');
    expect(overrides.get(asRelPath('b.md'))).toBe('deleteLocal');
  });

  it('returns empty map for empty input', () => {
    const overrides = collectDeleteOverrides(new Map());
    expect(overrides.size).toBe(0);
  });
});
