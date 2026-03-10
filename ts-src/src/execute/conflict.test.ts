import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { backupFile, conflictFallback } from './conflict.js';
import { emptyStats } from './executor.js';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../metadata/store.js';
import { asDirId, asEpochSeconds, asFileId } from '../types/common.js';
import type { NoteDomain } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { YoudaoNoteApi } from '../api/client.js';

describe('backupFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'conflict-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a .conflict. backup', () => {
    const src = join(tmpDir, 'test.md');
    writeFileSync(src, 'hello');

    const backup = backupFile(src);

    expect(backup).not.toBeNull();
    expect(backup!).toContain('.conflict.');
    expect(existsSync(backup!)).toBe(true);
  });

  it('returns null for non-existent file', () => {
    expect(backupFile(join(tmpDir, 'nonexistent.md'))).toBeNull();
  });
});

function makeCloudFile(id: string, name: string): CloudFile {
  return {
    id: asFileId(id),
    parentId: asDirId('root'),
    name,
    isDir: false,
    mtime: asEpochSeconds(1000),
    ctime: asEpochSeconds(900),
    domain: 1 as NoteDomain,
  };
}

describe('conflictFallback: push direction', () => {
  let tmpDir: string;
  let localDir: string;
  let meta: MetadataStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'conflict-cp-'));
    localDir = join(tmpDir, 'notes');
    mkdirSync(localDir, { recursive: true });
    meta = new MetadataStore(join(tmpDir, 'meta.db'));
  });

  afterEach(() => {
    meta.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('push fallback records localPath in changedPaths', async () => {
    const localPath = join(localDir, 'doc.md');
    writeFileSync(localPath, 'local version');

    const api = {
      pushFile: vi.fn().mockResolvedValue({
        entry: { id: 'new-id', modifyTimeForSort: 9999 },
      }),
      createDir: vi.fn().mockResolvedValue({ fileEntry: { id: 'dir-1' } }),
      pushBinaryFile: vi.fn().mockResolvedValue({ entry: { modifyTimeForSort: 9999 } }),
    } as unknown as YoudaoNoteApi;

    const stats = emptyStats();
    await conflictFallback({
      relPath: 'doc.md',
      localPath,
      cloudFile: makeCloudFile('cf1', 'doc.md'),
      ctx: { api, meta, rootDirId: asDirId('root'), localDir },
      stats,
      direction: 'push',
    });

    expect(stats.conflicts).toBe(1);
    expect(stats.uploaded).toBe(1);
    expect(stats.changedPaths).toContain(localPath);
  });
});

describe('conflictFallback: pull direction', () => {
  let tmpDir: string;
  let localDir: string;
  let meta: MetadataStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'conflict-pull-'));
    localDir = join(tmpDir, 'notes');
    mkdirSync(localDir, { recursive: true });
    meta = new MetadataStore(join(tmpDir, 'meta.db'));
  });

  afterEach(() => {
    meta.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pull fallback records localPath in changedPaths', async () => {
    const localPath = join(localDir, 'doc.md');
    writeFileSync(localPath, 'local version');

    const cloudContent = '# From cloud';
    const api = {
      getFileById: vi.fn().mockResolvedValue(new TextEncoder().encode(cloudContent).buffer),
    } as unknown as YoudaoNoteApi;

    const stats = emptyStats();
    await conflictFallback({
      relPath: 'doc.md',
      localPath,
      cloudFile: makeCloudFile('cf2', 'doc.md'),
      ctx: { api, meta, rootDirId: asDirId('root'), localDir },
      stats,
      direction: 'pull',
    });

    expect(stats.conflicts).toBe(1);
    expect(stats.changedPaths).toContain(localPath);
    expect(readFileSync(localPath, 'utf-8')).toBe(cloudContent);
  });

  it('both direction falls through to pull fallback', async () => {
    const localPath = join(localDir, 'doc.md');
    writeFileSync(localPath, 'local');

    const api = {
      getFileById: vi.fn().mockResolvedValue(new TextEncoder().encode('cloud').buffer),
    } as unknown as YoudaoNoteApi;

    const stats = emptyStats();
    await conflictFallback({
      relPath: 'doc.md',
      localPath,
      cloudFile: makeCloudFile('cf3', 'doc.md'),
      ctx: { api, meta, rootDirId: asDirId('root'), localDir },
      stats,
      direction: 'both',
    });

    expect(stats.conflicts).toBe(1);
    expect(stats.changedPaths).toContain(localPath);
  });

  it('creates conflict backup before overwriting', async () => {
    const localPath = join(localDir, 'doc.md');
    writeFileSync(localPath, 'original content');

    const api = {
      getFileById: vi.fn().mockResolvedValue(new TextEncoder().encode('new').buffer),
    } as unknown as YoudaoNoteApi;

    const stats = emptyStats();
    await conflictFallback({
      relPath: 'doc.md',
      localPath,
      cloudFile: makeCloudFile('cf4', 'doc.md'),
      ctx: { api, meta, rootDirId: asDirId('root'), localDir },
      stats,
      direction: 'pull',
    });

    const files = readdirSync(localDir);
    const backups = files.filter((f: string) => f.includes('.conflict.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });
});
