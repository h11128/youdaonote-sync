import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from './store.js';
import type { FileId, ContentHash } from '../types/common.js';

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
    meta.recordSync('a.md', {
      fileId: 'f1' as FileId,
      cloudMtime: 100,
      localMtime: 100,
      action: 'download',
      direction: 'pull',
    });
    const logs = meta.getSyncLog();
    expect(logs.length).toBe(1);
    expect(logs[0]!.action).toBe('download');
    expect(logs[0]!.direction).toBe('pull');
  });

  it('filters by path', () => {
    meta.recordSync('a.md', {
      fileId: 'f1' as FileId,
      cloudMtime: 100,
      localMtime: 100,
      action: 'download',
    });
    meta.recordSync('b.md', {
      fileId: 'f2' as FileId,
      cloudMtime: 200,
      localMtime: 200,
      action: 'upload',
    });
    const logs = meta.getSyncLog({ path: 'a.md' });
    expect(logs.length).toBe(1);
    expect(logs[0]!.path).toBe('a.md');
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      meta.recordSync(`f${i}.md`, {
        fileId: `id${i}` as FileId,
        cloudMtime: i,
        localMtime: i,
        action: 'sync',
      });
    }
    expect(meta.getSyncLog({ limit: 3 })).toHaveLength(3);
  });
});

describe('file_base operations', () => {
  it('saves and retrieves base content', () => {
    const content = Buffer.from('hello world');
    meta.saveBaseContent('test.md', content, 'abc123');
    const result = meta.getBaseContent('test.md');
    expect(result).not.toBeNull();
    expect(result!.hash).toBe('abc123');
    expect(result!.content.toString()).toBe('hello world');
  });

  it('returns null for missing base', () => {
    expect(meta.getBaseContent('nope.md')).toBeNull();
  });

  it('removes base content', () => {
    meta.saveBaseContent('test.md', Buffer.from('x'), 'h');
    meta.removeBaseContent('test.md');
    expect(meta.getBaseContent('test.md')).toBeNull();
  });

  it('overwrites on re-save', () => {
    meta.saveBaseContent('test.md', Buffer.from('v1'), 'h1');
    meta.saveBaseContent('test.md', Buffer.from('v2'), 'h2');
    const result = meta.getBaseContent('test.md');
    expect(result!.hash).toBe('h2');
    expect(result!.content.toString()).toBe('v2');
  });
});

describe('batch', () => {
  it('commits all operations atomically', () => {
    meta.batch(() => {
      meta.setFileInfo('a.md', { fileId: 'f1' as FileId, cloudMtime: 1, localMtime: 1 });
      meta.setFileInfo('b.md', { fileId: 'f2' as FileId, cloudMtime: 2, localMtime: 2 });
    });
    expect(meta.getFileInfo('a.md')).not.toBeNull();
    expect(meta.getFileInfo('b.md')).not.toBeNull();
  });

  it('rolls back on error', () => {
    try {
      meta.batch(() => {
        meta.setFileInfo('c.md', { fileId: 'f3' as FileId, cloudMtime: 3, localMtime: 3 });
        throw new Error('deliberate');
      });
    } catch {
      /* expected */
    }
    expect(meta.getFileInfo('c.md')).toBeNull();
  });
});

describe('findCloudFileByHash', () => {
  it('finds cloud file with matching hash', () => {
    meta.setFileInfo('a.md', {
      fileId: 'WEB1' as FileId,
      cloudMtime: 1,
      localMtime: 1,
      contentHash: 'abc123' as ContentHash,
    });
    expect(meta.findCloudFileByHash('abc123' as ContentHash)).toBe('a.md');
  });

  it('returns null when no match', () => {
    meta.setFileInfo('a.md', {
      fileId: 'WEB1' as FileId,
      cloudMtime: 1,
      localMtime: 1,
      contentHash: 'abc' as ContentHash,
    });
    expect(meta.findCloudFileByHash('zzz' as ContentHash)).toBeNull();
  });

  it('excludes self', () => {
    meta.setFileInfo('a.md', {
      fileId: 'WEB1' as FileId,
      cloudMtime: 1,
      localMtime: 1,
      contentHash: 'abc' as ContentHash,
    });
    expect(meta.findCloudFileByHash('abc' as ContentHash, 'a.md')).toBeNull();
  });

  it('excludes self but returns other match', () => {
    meta.setFileInfo('a.md', {
      fileId: 'WEB1' as FileId,
      cloudMtime: 1,
      localMtime: 1,
      contentHash: 'abc' as ContentHash,
    });
    meta.setFileInfo('b.md', {
      fileId: 'WEB2' as FileId,
      cloudMtime: 2,
      localMtime: 2,
      contentHash: 'abc' as ContentHash,
    });
    const result = meta.findCloudFileByHash('abc' as ContentHash, 'a.md');
    expect(result).toBe('b.md');
  });

  it('ignores files without file_id', () => {
    meta.setFileInfo('local.md', {
      fileId: '' as FileId,
      cloudMtime: 1,
      localMtime: 1,
      contentHash: 'abc' as ContentHash,
    });
    expect(meta.findCloudFileByHash('abc' as ContentHash)).toBeNull();
  });

  it('returns null for null hash', () => {
    expect(meta.findCloudFileByHash(null as unknown as ContentHash)).toBeNull();
  });
});

describe('file_refs', () => {
  it('roundtrip set and get', () => {
    meta.setFileRefs('doc.md', ['img/a.png', 'img/b.jpg']);
    const refs = meta.getFileRefs('doc.md');
    expect(refs.sort()).toEqual(['img/a.png', 'img/b.jpg']);
  });

  it('replace refs', () => {
    meta.setFileRefs('doc.md', ['old.png']);
    meta.setFileRefs('doc.md', ['new.png']);
    expect(meta.getFileRefs('doc.md')).toEqual(['new.png']);
  });

  it('getAllFileRefs', () => {
    meta.setFileRefs('a.md', ['x.png']);
    meta.setFileRefs('b.md', ['y.png', 'z.png']);
    const all = meta.getAllFileRefs();
    expect(all.has('a.md')).toBe(true);
    expect(all.get('b.md')?.length).toBe(2);
  });
});
