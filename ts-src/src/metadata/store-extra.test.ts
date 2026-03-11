import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from './store.js';
import {
  asFileId,
  asContentHash,
  asRelPath,
  asEpochSeconds,
  type ContentHash,
} from '../types/common.js';

const TMP = join(tmpdir(), `store-extra-test-${Date.now()}`);
const DB_PATH = join(TMP, 'meta.db');
let meta: MetadataStore;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  meta = new MetadataStore(DB_PATH);
});

afterEach(() => {
  meta.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe('getSyncLog', () => {
  it('returns empty array when no logs', () => {
    expect(meta.getSyncLog()).toHaveLength(0);
  });

  it('records and retrieves sync log entries', () => {
    meta.recordSync(asRelPath('a.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(100),
      action: 'download',
      direction: 'pull',
    });
    const logs = meta.getSyncLog();
    expect(logs.length).toBe(1);
    expect(logs[0]!.action).toBe('download');
    expect(logs[0]!.direction).toBe('pull');
  });

  it('filters by path', () => {
    meta.recordSync(asRelPath('a.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(100),
      action: 'download',
    });
    meta.recordSync(asRelPath('b.md'), {
      fileId: asFileId('f2'),
      cloudMtime: asEpochSeconds(200),
      localMtime: asEpochSeconds(200),
      action: 'upload',
    });
    const logs = meta.getSyncLog({ path: asRelPath('a.md') });
    expect(logs.length).toBe(1);
    expect(logs[0]!.path).toBe('a.md');
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      meta.recordSync(asRelPath(`f${i}.md`), {
        fileId: asFileId(`id${i}`),
        cloudMtime: asEpochSeconds(i),
        localMtime: asEpochSeconds(i),
        action: 'sync',
      });
    }
    expect(meta.getSyncLog({ limit: 3 })).toHaveLength(3);
  });
});

describe('file_base operations', () => {
  it('saves and retrieves base content', () => {
    const content = Buffer.from('hello world');
    meta.saveBaseContent(asRelPath('test.md'), content, 'abc123');
    const result = meta.getBaseContent(asRelPath('test.md'));
    expect(result).not.toBeNull();
    expect(result!.hash).toBe('abc123');
    expect(result!.content.toString()).toBe('hello world');
  });

  it('returns null for missing base', () => {
    expect(meta.getBaseContent(asRelPath('nope.md'))).toBeNull();
  });

  it('removes base content', () => {
    meta.saveBaseContent(asRelPath('test.md'), Buffer.from('x'), 'h');
    meta.removeBaseContent(asRelPath('test.md'));
    expect(meta.getBaseContent(asRelPath('test.md'))).toBeNull();
  });

  it('overwrites on re-save', () => {
    meta.saveBaseContent(asRelPath('test.md'), Buffer.from('v1'), 'h1');
    meta.saveBaseContent(asRelPath('test.md'), Buffer.from('v2'), 'h2');
    const result = meta.getBaseContent(asRelPath('test.md'));
    expect(result!.hash).toBe('h2');
    expect(result!.content.toString()).toBe('v2');
  });
});

describe('batch', () => {
  it('commits all operations atomically', () => {
    meta.batch(() => {
      meta.setFileInfo(asRelPath('a.md'), {
        fileId: asFileId('f1'),
        cloudMtime: asEpochSeconds(1),
        localMtime: asEpochSeconds(1),
      });
      meta.setFileInfo(asRelPath('b.md'), {
        fileId: asFileId('f2'),
        cloudMtime: asEpochSeconds(2),
        localMtime: asEpochSeconds(2),
      });
    });
    expect(meta.getFileInfo(asRelPath('a.md'))).not.toBeNull();
    expect(meta.getFileInfo(asRelPath('b.md'))).not.toBeNull();
  });

  it('rolls back on error', () => {
    try {
      meta.batch(() => {
        meta.setFileInfo(asRelPath('c.md'), {
          fileId: asFileId('f3'),
          cloudMtime: asEpochSeconds(3),
          localMtime: asEpochSeconds(3),
        });
        throw new Error('deliberate');
      });
    } catch {
      /* expected */
    }
    expect(meta.getFileInfo(asRelPath('c.md'))).toBeNull();
  });
});

describe('findCloudFileByHash', () => {
  it('finds cloud file with matching hash', () => {
    meta.setFileInfo(asRelPath('a.md'), {
      fileId: asFileId('WEB1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: asContentHash('abc123'),
    });
    expect(meta.findCloudFileByHash(asContentHash('abc123'))).toBe('a.md');
  });

  it('returns null when no match', () => {
    meta.setFileInfo(asRelPath('a.md'), {
      fileId: asFileId('WEB1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: asContentHash('abc'),
    });
    expect(meta.findCloudFileByHash(asContentHash('zzz'))).toBeNull();
  });

  it('excludes self', () => {
    meta.setFileInfo(asRelPath('a.md'), {
      fileId: asFileId('WEB1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: asContentHash('abc'),
    });
    expect(meta.findCloudFileByHash(asContentHash('abc'), asRelPath('a.md'))).toBeNull();
  });

  it('excludes self but returns other match', () => {
    meta.setFileInfo(asRelPath('a.md'), {
      fileId: asFileId('WEB1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: asContentHash('abc'),
    });
    meta.setFileInfo(asRelPath('b.md'), {
      fileId: asFileId('WEB2'),
      cloudMtime: asEpochSeconds(2),
      localMtime: asEpochSeconds(2),
      contentHash: asContentHash('abc'),
    });
    const result = meta.findCloudFileByHash(asContentHash('abc'), asRelPath('a.md'));
    expect(result).toBe('b.md');
  });

  it('ignores files without file_id', () => {
    meta.setFileInfo(asRelPath('local.md'), {
      fileId: asFileId(''),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
      contentHash: asContentHash('abc'),
    });
    expect(meta.findCloudFileByHash(asContentHash('abc'))).toBeNull();
  });

  it('returns null for null hash', () => {
    expect(meta.findCloudFileByHash(null as unknown as ContentHash)).toBeNull();
  });
});

describe('renamePath cascades to file_base and file_refs', () => {
  it('migrates file_base entry to new path', () => {
    meta.setFileInfo(asRelPath('old.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
    });
    meta.saveBaseContent(asRelPath('old.md'), Buffer.from('base content'), 'hash1');

    meta.renamePath(asRelPath('old.md'), asRelPath('new.md'));

    expect(meta.getBaseContent(asRelPath('old.md'))).toBeNull();
    const base = meta.getBaseContent(asRelPath('new.md'));
    expect(base).not.toBeNull();
    expect(base!.content.toString()).toBe('base content');
    expect(base!.hash).toBe('hash1');
  });

  it('migrates file_refs source_path to new path', () => {
    meta.setFileInfo(asRelPath('old.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
    });
    meta.setFileRefs(asRelPath('old.md'), ['img/a.png', 'img/b.png']);

    meta.renamePath(asRelPath('old.md'), asRelPath('new.md'));

    expect(meta.getFileRefs(asRelPath('old.md'))).toHaveLength(0);
    expect(meta.getFileRefs(asRelPath('new.md')).sort()).toEqual(['img/a.png', 'img/b.png']);
  });

  it('cleans up old entries on UNIQUE conflict', () => {
    meta.setFileInfo(asRelPath('old.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(1),
      localMtime: asEpochSeconds(1),
    });
    meta.setFileInfo(asRelPath('new.md'), {
      fileId: asFileId('f2'),
      cloudMtime: asEpochSeconds(2),
      localMtime: asEpochSeconds(2),
    });
    meta.saveBaseContent(asRelPath('old.md'), Buffer.from('old base'), 'h1');

    const ok = meta.renamePath(asRelPath('old.md'), asRelPath('new.md'));
    expect(ok).toBe(false);
    expect(meta.getFileInfo(asRelPath('old.md'))).toBeNull();
    expect(meta.getBaseContent(asRelPath('old.md'))).toBeNull();
  });
});

describe('file_refs', () => {
  it('roundtrip set and get', () => {
    meta.setFileRefs(asRelPath('doc.md'), ['img/a.png', 'img/b.jpg']);
    const refs = meta.getFileRefs(asRelPath('doc.md'));
    expect(refs.sort()).toEqual(['img/a.png', 'img/b.jpg']);
  });

  it('replace refs', () => {
    meta.setFileRefs(asRelPath('doc.md'), ['old.png']);
    meta.setFileRefs(asRelPath('doc.md'), ['new.png']);
    expect(meta.getFileRefs(asRelPath('doc.md'))).toEqual(['new.png']);
  });

  it('getAllFileRefs', () => {
    meta.setFileRefs(asRelPath('a.md'), ['x.png']);
    meta.setFileRefs(asRelPath('b.md'), ['y.png', 'z.png']);
    const all = meta.getAllFileRefs();
    expect(all.has(asRelPath('a.md'))).toBe(true);
    expect(all.get(asRelPath('b.md'))?.length).toBe(2);
  });
});
