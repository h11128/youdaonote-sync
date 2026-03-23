import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from './store.js';
import { verify, gc, heal, healPreScan, healPostHash, VerifyIssueType } from './health.js';
import { computeContentHashFromFile } from '../algo/hash.js';
import { asFileId, asDirId, asContentHash, asRelPath, asEpochSeconds } from '../types/common.js';
import type { ContentHash, RelPath } from '../types/common.js';

const TMP = join(tmpdir(), `health-test-${Date.now()}`);
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
    meta.setFileInfo(asRelPath('missing.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(100),
    });
    const issues = verify(meta, LOCAL);
    expect(issues.some((i) => i.type === VerifyIssueType.ORPHAN)).toBe(true);
  });

  it('detects hash mismatch and auto-fixes', () => {
    const p = join(LOCAL, 'test.md');
    writeFileSync(p, 'actual content');
    meta.setFileInfo(asRelPath('test.md'), {
      fileId: asFileId('f2'),
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(100),
      contentHash: asContentHash('wrong_hash'),
    });
    const issues = verify(meta, LOCAL, true);
    expect(issues.some((i) => i.type === VerifyIssueType.HASH_MISMATCH)).toBe(true);
    // After auto-fix, hash should be updated
    const updated = meta.getContentHash(asRelPath('test.md'));
    expect(updated).not.toBe('wrong_hash');
    expect(updated).toBeTruthy();
  });

  it('detects orphan directory records', () => {
    meta.setDirInfo(asRelPath('gone_dir'), asDirId('d1'));
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
    meta.setFileInfo(asRelPath('old.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(100),
      lastSyncAt: asEpochSeconds(oldTs),
    });
    const stats = gc(meta, LOCAL);
    expect(stats.files).toBe(1);
  });

  it('cleans up orphan directory records', () => {
    meta.setDirInfo(asRelPath('gone'), asDirId('d1'));
    const stats = gc(meta, LOCAL);
    expect(stats.dirs).toBe(1);
  });

  it('cleans up old sync_log entries', () => {
    const db = meta.connection;
    const oldTs = asEpochSeconds(Math.floor(Date.now() / 1000) - 100 * 86400);
    db.prepare('INSERT INTO sync_log (timestamp, path, action) VALUES (?, ?, ?)').run(
      oldTs,
      'old.md',
      'download',
    );
    const stats = gc(meta, LOCAL);
    expect(stats.logs).toBe(1);
  });
});

describe('heal', () => {
  it('throws when localDir is empty', () => {
    expect(() => heal(meta, '')).toThrow(/localDir must be a non-empty string/);
  });

  it('detects orphan records (no file_id, no local file)', () => {
    meta.setFileInfo(asRelPath('phantom.md'), {
      fileId: asFileId(''),
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(100),
    });
    const stats = heal(meta, LOCAL);
    expect(stats.orphan).toBe(1);
  });

  it('auto-fixes orphan records when autoFix=true', () => {
    meta.setFileInfo(asRelPath('phantom.md'), {
      fileId: asFileId(''),
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(100),
    });
    heal(meta, LOCAL, true);
    expect(meta.getFileInfo(asRelPath('phantom.md'))).toBeNull();
  });
});

describe('healPreScan', () => {
  it('throws when localDir is empty', () => {
    expect(() => healPreScan(meta, '')).toThrow(/localDir must be a non-empty string/);
  });

  it('detects and removes orphan records', () => {
    meta.setFileInfo(asRelPath('phantom.md'), {
      fileId: asFileId(''),
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(100),
    });

    const stats = healPreScan(meta, LOCAL, true);

    expect(stats.orphan).toBe(1);
    expect(meta.getFileInfo(asRelPath('phantom.md'))).toBeNull();
  });

  it('counts zeroCloud records', () => {
    meta.setFileInfo(asRelPath('zero.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(100),
    });
    writeFileSync(join(LOCAL, 'zero.md'), 'content');

    const stats = healPreScan(meta, LOCAL);

    expect(stats.zeroCloud).toBe(1);
  });

  it('does not run mtime drift or hash backfill', () => {
    const p = join(LOCAL, 'drift.md');
    writeFileSync(p, 'content');
    const mtime = Math.floor(statSync(p).mtimeMs / 1000);
    meta.setFileInfo(asRelPath('drift.md'), {
      fileId: asFileId('f2'),
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(mtime - 999),
      contentHash: asContentHash('somehash'),
    });

    const stats = healPreScan(meta, LOCAL, true);

    expect(stats.orphan).toBe(0);
    expect(stats.zeroCloud).toBe(0);
  });
});

describe('healPostHash', () => {
  it('throws when localDir is empty', () => {
    const hashes = new Map<RelPath, ContentHash | null>();
    expect(() => healPostHash(meta, '', hashes)).toThrow(/localDir must be a non-empty string/);
  });

  it('detects mtime drift and fixes when hash matches', () => {
    const p = join(LOCAL, 'drift.md');
    writeFileSync(p, 'stable content');
    const actualHash = computeContentHashFromFile(p)!;
    const actualMtime = Math.floor(statSync(p).mtimeMs / 1000);

    meta.setFileInfo(asRelPath('drift.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(actualMtime - 50),
      contentHash: actualHash,
    });

    const hashes = new Map<RelPath, ContentHash | null>([[asRelPath('drift.md'), actualHash]]);
    const stats = healPostHash(meta, LOCAL, hashes, true);

    expect(stats.mtimeDrift).toBe(1);
    const updated = meta.getFileInfo(asRelPath('drift.md'));
    expect(updated?.localMtime).toBe(actualMtime);
  });

  it('backfills missing hash for synced files', () => {
    const p = join(LOCAL, 'nohash.md');
    writeFileSync(p, 'backfill me');
    const actualMtime = Math.floor(statSync(p).mtimeMs / 1000);

    meta.setFileInfo(asRelPath('nohash.md'), {
      fileId: asFileId('f2'),
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(actualMtime),
    });

    const hashes = new Map<RelPath, ContentHash | null>([
      [asRelPath('nohash.md'), asContentHash('computed-hash')],
    ]);
    const stats = healPostHash(meta, LOCAL, hashes, true);

    expect(stats.hashBackfill).toBe(1);
    expect(meta.getContentHash(asRelPath('nohash.md'))).toBe('computed-hash');
  });

  it('uses provided localHashes instead of computing from file', () => {
    const p = join(LOCAL, 'precomputed.md');
    writeFileSync(p, 'some data');
    const actualMtime = Math.floor(statSync(p).mtimeMs / 1000);

    meta.setFileInfo(asRelPath('precomputed.md'), {
      fileId: asFileId('f3'),
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(actualMtime),
    });

    const precomputed = asContentHash('precomputed-hash-value');
    const hashes = new Map<RelPath, ContentHash | null>([
      [asRelPath('precomputed.md'), precomputed],
    ]);
    const stats = healPostHash(meta, LOCAL, hashes, true);

    expect(stats.hashBackfill).toBe(1);
    expect(meta.getContentHash(asRelPath('precomputed.md'))).toBe('precomputed-hash-value');
  });
});
