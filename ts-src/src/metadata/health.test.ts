import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from './store.js';
import { verify, gc, heal, VerifyIssueType } from './health.js';
import type { ContentHash, FileId, DirId } from '../types/common.js';

const TMP = join(tmpdir(), 'health-test-' + Date.now());
const DB_PATH = join(TMP, 'meta.db');
const LOCAL = join(TMP, 'notes');

let meta: MetadataStore;

beforeEach(() => {
  mkdirSync(LOCAL, { recursive: true });
  meta = new MetadataStore(DB_PATH);
});

afterEach(() => {
  meta.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe('verify', () => {
  it('throws when localDir is empty', () => {
    expect(() => verify(meta, '')).toThrow(/localDir must be a non-empty string/);
    expect(() => verify(meta, null as unknown as string)).toThrow(/localDir must be/);
  });

  it('detects orphan file records', () => {
    meta.setFileInfo('missing.md', {
      fileId: 'f1' as FileId, cloudMtime: 100, localMtime: 100,
    });
    const issues = verify(meta, LOCAL);
    expect(issues.some((i) => i.type === VerifyIssueType.ORPHAN)).toBe(true);
  });

  it('detects hash mismatch and auto-fixes', () => {
    const p = join(LOCAL, 'test.md');
    writeFileSync(p, 'actual content');
    meta.setFileInfo('test.md', {
      fileId: 'f2' as FileId, cloudMtime: 100, localMtime: 100,
      contentHash: 'wrong_hash' as ContentHash,
    });
    const issues = verify(meta, LOCAL, true);
    expect(issues.some((i) => i.type === VerifyIssueType.HASH_MISMATCH)).toBe(true);
    // After auto-fix, hash should be updated
    const updated = meta.getContentHash('test.md');
    expect(updated).not.toBe('wrong_hash');
    expect(updated).toBeTruthy();
  });

  it('detects orphan directory records', () => {
    meta.setDirInfo('gone_dir', 'd1' as DirId);
    const issues = verify(meta, LOCAL);
    expect(issues.some((i) => i.type === VerifyIssueType.ORPHAN_DIR)).toBe(true);
  });
});

describe('gc', () => {
  it('throws when localDir is empty', () => {
    expect(() => gc(meta, '')).toThrow(/localDir must be a non-empty string/);
  });

  it('cleans up orphan file records', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 40 * 86400;
    meta.setFileInfo('old.md', {
      fileId: 'f1' as FileId, cloudMtime: 100, localMtime: 100,
      lastSyncAt: oldTs,
    });
    const stats = gc(meta, LOCAL);
    expect(stats.files).toBe(1);
  });

  it('cleans up orphan directory records', () => {
    meta.setDirInfo('gone', 'd1' as DirId);
    const stats = gc(meta, LOCAL);
    expect(stats.dirs).toBe(1);
  });

  it('cleans up old sync_log entries', () => {
    const db = meta.connection;
    const oldTs = Math.floor(Date.now() / 1000) - 100 * 86400;
    db.prepare(
      "INSERT INTO sync_log (timestamp, path, action) VALUES (?, ?, ?)",
    ).run(oldTs, 'old.md', 'download');
    const stats = gc(meta, LOCAL);
    expect(stats.logs).toBe(1);
  });
});

describe('heal', () => {
  it('throws when localDir is empty', () => {
    expect(() => heal(meta, '')).toThrow(/localDir must be a non-empty string/);
  });

  it('detects orphan records (no file_id, no local file)', () => {
    meta.setFileInfo('phantom.md', {
      fileId: '' as FileId, cloudMtime: 0, localMtime: 100,
    });
    const stats = heal(meta, LOCAL);
    expect(stats.orphan).toBe(1);
  });

  it('auto-fixes orphan records when autoFix=true', () => {
    meta.setFileInfo('phantom.md', {
      fileId: '' as FileId, cloudMtime: 0, localMtime: 100,
    });
    heal(meta, LOCAL, true);
    expect(meta.getFileInfo('phantom.md')).toBeNull();
  });
});
