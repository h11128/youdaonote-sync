/**
 * Unit tests for purge-nonsyncable (artifact / .note / dir rows in files table).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../metadata/store.js';
import { asEpochSeconds, asFileId, asRelPath } from '../types/common.js';
import { isNonSyncableFilesTablePath, purgeNonSyncableFileRows } from './purge-nonsyncable.js';

describe('purgeNonSyncableFileRows', () => {
  let dir: string;
  let meta: MetadataStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'purge-ns-'));
    meta = new MetadataStore(join(dir, 'meta.db'));
  });

  afterEach(() => {
    meta.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags images/attachments/.note and on-disk directories', () => {
    mkdirSync(join(dir, 'notes'), { recursive: true });
    expect(isNonSyncableFilesTablePath(asRelPath('a/images/x.png'), dir)).toBe(true);
    expect(isNonSyncableFilesTablePath(asRelPath('a/attachments/d.pdf'), dir)).toBe(true);
    expect(isNonSyncableFilesTablePath(asRelPath('diary/old.note'), dir)).toBe(true);
    expect(isNonSyncableFilesTablePath(asRelPath('notes'), dir)).toBe(true);
    expect(isNonSyncableFilesTablePath(asRelPath('ok.md'), dir)).toBe(false);
  });

  it('removes non-syncable rows and keeps normal files', () => {
    writeFileSync(join(dir, 'keep.md'), 'x');
    mkdirSync(join(dir, 'folder'), { recursive: true });
    meta.setFileInfo(asRelPath('keep.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
    });
    meta.setFileInfo(asRelPath('folder'), {
      fileId: asFileId(''),
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(1),
    });
    meta.setFileInfo(asRelPath('x/images/a.png'), {
      fileId: asFileId(''),
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(1),
    });
    meta.setFileInfo(asRelPath('old.note'), {
      fileId: asFileId(''),
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(1),
    });

    const n = purgeNonSyncableFileRows(meta, dir);
    expect(n).toBe(3);
    expect(meta.getFileInfo(asRelPath('keep.md'))?.fileId).toBe('f1');
    expect(meta.getFileInfo(asRelPath('folder'))).toBeNull();
    expect(meta.getFileInfo(asRelPath('x/images/a.png'))).toBeNull();
    expect(meta.getFileInfo(asRelPath('old.note'))).toBeNull();
  });

  it('purges deleted extensionless dir leftovers and .clip', () => {
    meta.setFileInfo(asRelPath('ghost-dir'), {
      fileId: asFileId(''),
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(1),
    });
    meta.setFileInfo(asRelPath('old.clip'), {
      fileId: asFileId(''),
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(1),
    });
    meta.setFileInfo(asRelPath('keep.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
    });
    writeFileSync(join(dir, 'keep.md'), 'x');
    const n = purgeNonSyncableFileRows(meta, dir);
    expect(n).toBe(2);
    expect(meta.getFileInfo(asRelPath('ghost-dir'))).toBeNull();
    expect(meta.getFileInfo(asRelPath('old.clip'))).toBeNull();
    expect(meta.getFileInfo(asRelPath('keep.md'))?.fileId).toBe('f1');
  });
});
