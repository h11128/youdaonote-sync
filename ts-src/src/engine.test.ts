import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SyncEngine } from './engine.js';
import { filterCloudSnap, filterByDirection } from './engine-helpers.js';
import type { YoudaoNoteApi } from './api/client.js';
import { asDirId, asFileId } from './types/common.js';
import type { NoteDomain } from './types/common.js';
import type { CloudFile } from './types/scan.js';
import type { FileState } from './types/state.js';
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
    const mockApi = {
      loginByCookies: () => null,
      getRootId: () => Promise.resolve(asDirId('injected-root')),
      getDirInfoById: () => Promise.resolve({ entries: [] } as DirInfoByIdResponse),
    } as unknown as YoudaoNoteApi;

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

function fakeCloudFile(name: string): CloudFile {
  return {
    id: asFileId('f-' + name),
    parentId: asDirId('root'),
    name,
    isDir: false,
    mtime: 1000,
    ctime: 900,
    domain: 0 as NoteDomain,
  };
}

describe('filterCloudSnap', () => {
  it('removes entries matching exclude patterns', () => {
    const snap = new Map<string, CloudFile>([
      ['keep.md', fakeCloudFile('keep.md')],
      ['secret.md', fakeCloudFile('secret.md')],
      ['dir/secret-too.md', fakeCloudFile('secret-too.md')],
    ]);

    filterCloudSnap(snap, { exclude: ['secret*'] });

    expect([...snap.keys()]).toEqual(['keep.md']);
  });

  it('keeps only entries matching include patterns', () => {
    const snap = new Map<string, CloudFile>([
      ['notes/a.md', fakeCloudFile('a.md')],
      ['notes/b.txt', fakeCloudFile('b.txt')],
      ['other/c.md', fakeCloudFile('c.md')],
    ]);

    filterCloudSnap(snap, { include: ['*.md'] });

    expect(snap.has('notes/a.md')).toBe(true);
    expect(snap.has('other/c.md')).toBe(true);
    expect(snap.has('notes/b.txt')).toBe(false);
  });

  it('no-ops when both include and exclude are empty', () => {
    const snap = new Map<string, CloudFile>([['a.md', fakeCloudFile('a.md')]]);

    filterCloudSnap(snap, {});

    expect(snap.size).toBe(1);
  });

  it('exclude takes precedence over include', () => {
    const snap = new Map<string, CloudFile>([
      ['notes/keep.md', fakeCloudFile('keep.md')],
      ['notes/secret.md', fakeCloudFile('secret.md')],
    ]);

    filterCloudSnap(snap, { include: ['*.md'], exclude: ['secret*'] });

    expect(snap.has('notes/keep.md')).toBe(true);
    expect(snap.has('notes/secret.md')).toBe(false);
  });
});

describe('filterByDirection', () => {
  it('pull keeps downloads and conflicts, removes uploads', () => {
    const classified = new Map<string, FileState>([
      ['cloud-new.md', { kind: 'cloudNew' }],
      ['local-new.md', { kind: 'localNew' }],
      ['conflict.md', { kind: 'conflict' }],
      ['synced.md', { kind: 'synced' }],
      ['moved.md', { kind: 'moved', oldPath: 'old.md' }],
    ]);

    filterByDirection(classified, 'pull');

    expect(classified.get('cloud-new.md')?.kind).toBe('cloudNew');
    expect(classified.get('conflict.md')?.kind).toBe('conflict');
    expect(classified.get('local-new.md')?.kind).toBe('gone');
    expect(classified.get('synced.md')?.kind).toBe('synced');
    expect(classified.get('moved.md')?.kind).toBe('moved');
  });

  it('push keeps uploads, removes downloads and conflicts', () => {
    const classified = new Map<string, FileState>([
      ['cloud-new.md', { kind: 'cloudNew' }],
      ['local-new.md', { kind: 'localNew' }],
      ['conflict.md', { kind: 'conflict' }],
      ['local-mod.md', { kind: 'localModified' }],
    ]);

    filterByDirection(classified, 'push');

    expect(classified.get('local-new.md')?.kind).toBe('localNew');
    expect(classified.get('local-mod.md')?.kind).toBe('localModified');
    expect(classified.get('cloud-new.md')?.kind).toBe('gone');
    expect(classified.get('conflict.md')?.kind).toBe('gone');
  });
});
