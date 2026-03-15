import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type RelPath, asEpochSeconds } from '../types/common.js';
import type { MetadataStore } from './store.js';
import { computeContentHashFromFile } from '../algo/hash.js';

export enum VerifyIssueType {
  ORPHAN = 'orphan',
  HASH_MISMATCH = 'hash_mismatch',
  ORPHAN_DIR = 'orphan_dir',
}

export interface VerifyIssue {
  readonly path: RelPath;
  readonly type: VerifyIssueType;
  readonly detail: string;
}

function verifyFileIssues(meta: MetadataStore, localDir: string): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const [path, record] of meta.getAllFiles()) {
    const full = join(localDir, path);
    if (!existsSync(full)) {
      if (record.fileId) {
        issues.push({
          path,
          type: VerifyIssueType.ORPHAN,
          detail: 'local file missing but has file_id',
        });
      }
      continue;
    }
    if (record.contentHash) {
      const actual = computeContentHashFromFile(full);
      if (actual && actual !== record.contentHash) {
        issues.push({
          path,
          type: VerifyIssueType.HASH_MISMATCH,
          detail: `recorded=${record.contentHash.slice(0, 16)}.. actual=${actual.slice(0, 16)}..`,
        });
      }
    }
  }
  return issues;
}

function verifyDirIssues(meta: MetadataStore, localDir: string): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const [path] of meta.getAllDirs()) {
    const full = join(localDir, path);
    if (!existsSync(full)) {
      issues.push({ path, type: VerifyIssueType.ORPHAN_DIR, detail: 'local directory missing' });
    }
  }
  return issues;
}

function applyVerifyFixes(meta: MetadataStore, localDir: string, issues: VerifyIssue[]): void {
  meta.batch(() => {
    for (const issue of issues) {
      switch (issue.type) {
        case VerifyIssueType.HASH_MISMATCH: {
          const actual = computeContentHashFromFile(join(localDir, issue.path));
          if (actual) {
            meta.updateContentHash(issue.path, actual);
          } else {
            console.warn(`verify: hash computation failed for ${issue.path}`);
          }
          break;
        }
        case VerifyIssueType.ORPHAN:
          meta.removeFileInfo(issue.path);
          break;
        case VerifyIssueType.ORPHAN_DIR:
          meta.removeDir(issue.path);
          break;
      }
    }
  });
}

/**
 * Verify metadata consistency against local files.
 *
 * Checks:
 * - Files in metadata but not on disk (orphans)
 * - content_hash mismatch between metadata and actual file
 * - Directories in metadata but not on disk
 *
 * @param autoFix When true, auto-repairs hash mismatches and removes orphan dirs.
 */
export function verify(meta: MetadataStore, localDir: string, autoFix = false): VerifyIssue[] {
  if (!localDir || typeof localDir !== 'string') {
    throw new Error('verify: localDir must be a non-empty string');
  }
  const issues = [...verifyFileIssues(meta, localDir), ...verifyDirIssues(meta, localDir)];
  if (autoFix && issues.length > 0) applyVerifyFixes(meta, localDir, issues);
  return issues;
}

export interface GcStats {
  readonly files: number;
  readonly dirs: number;
  readonly logs: number;
  readonly bases: number;
  readonly refs: number;
}

type MutableGcStats = { -readonly [K in keyof GcStats]: GcStats[K] };

/**
 * Garbage-collect expired and orphan metadata records.
 *
 * - files: synced > 30 days ago and local file no longer exists
 * - dirs: local directory no longer exists
 * - logs: sync_log entries older than maxLogAgeDays
 * - bases: file_base entries whose local file no longer exists
 */
export function gc(meta: MetadataStore, localDir: string, maxLogAgeDays = 90): GcStats {
  if (!localDir || typeof localDir !== 'string') {
    throw new Error('gc: localDir must be a non-empty string');
  }
  const stats: MutableGcStats = { files: 0, dirs: 0, logs: 0, bases: 0, refs: 0 };
  const now = Math.floor(Date.now() / 1000);
  const cutoff = asEpochSeconds(now - 30 * 86400);
  const logCutoff = asEpochSeconds(now - maxLogAgeDays * 86400);

  meta.batch(() => {
    for (const path of meta.getStaleFilePaths(cutoff)) {
      if (!existsSync(join(localDir, path))) {
        meta.removeFileInfo(path);
        stats.files++;
      }
    }

    for (const path of meta.getAllDirPaths()) {
      if (!existsSync(join(localDir, path))) {
        meta.removeDir(path);
        stats.dirs++;
      }
    }

    stats.logs = meta.deleteSyncLogBefore(logCutoff);

    for (const path of meta.getAllBaseContentPaths()) {
      if (!existsSync(join(localDir, path))) {
        meta.removeBaseContent(path);
        stats.bases++;
      }
    }

    for (const sourcePath of meta.getAllFileRefs().keys()) {
      if (!existsSync(join(localDir, sourcePath))) {
        meta.setFileRefs(sourcePath, []);
        stats.refs++;
      }
    }
  });

  return stats;
}

export interface HealStats {
  readonly mtimeDrift: number;
  readonly orphan: number;
  readonly zeroCloud: number;
  readonly hashBackfill: number;
}

type MutableHealStats = { -readonly [K in keyof HealStats]: HealStats[K] };

function healOrphanRecords(
  meta: MetadataStore,
  localDir: string,
  stats: MutableHealStats,
  autoFix: boolean,
): void {
  for (const [path, record] of meta.getAllFiles()) {
    const exists = existsSync(join(localDir, path));
    if (!exists && !record.fileId) {
      stats.orphan++;
      if (autoFix) meta.removeFileInfo(path);
    }
  }
}

function countZeroCloud(meta: MetadataStore): number {
  let count = 0;
  for (const [, record] of meta.getAllFiles()) {
    if (record.cloudMtime === 0 && record.fileId) count++;
  }
  return count;
}

function healMtimeDrift(
  meta: MetadataStore,
  localDir: string,
  stats: MutableHealStats,
  autoFix: boolean,
): void {
  for (const [path, record] of meta.getAllFiles()) {
    const full = join(localDir, path);
    if (!existsSync(full)) continue;
    if (!record.localMtime || !record.contentHash) continue;

    const actualMtime = Math.floor(statSync(full).mtimeMs / 1000);
    if (actualMtime === record.localMtime) continue;

    const actualHash = computeContentHashFromFile(full);
    if (actualHash && actualHash === record.contentHash) {
      stats.mtimeDrift++;
      if (autoFix) meta.updateLocalMtime(path, asEpochSeconds(actualMtime));
    }
  }
}

function healHashBackfill(
  meta: MetadataStore,
  localDir: string,
  stats: MutableHealStats,
  autoFix: boolean,
): void {
  for (const [path, record] of meta.getAllFiles()) {
    const full = join(localDir, path);
    if (!existsSync(full)) continue;
    if (record.contentHash || !record.fileId || !record.localMtime) continue;

    const actualMtime = Math.floor(statSync(full).mtimeMs / 1000);
    if (actualMtime !== record.localMtime) continue;

    const actualHash = computeContentHashFromFile(full);
    if (actualHash) {
      stats.hashBackfill++;
      if (autoFix) meta.updateContentHash(path, actualHash);
    }
  }
}

/**
 * Lightweight self-healing pass run before each sync.
 *
 * Detects and optionally repairs:
 * 1. local_mtime drift (os mtime differs but content_hash unchanged → update mtime)
 * 2. orphan records (no local file, no file_id → delete)
 * 3. cloud_mtime = 0 (legacy migration leftover → log warning)
 * 4. content_hash missing (has file_id + local_mtime but no hash → backfill)
 */
export function heal(meta: MetadataStore, localDir: string, autoFix = false): HealStats {
  if (!localDir || typeof localDir !== 'string') {
    throw new Error('heal: localDir must be a non-empty string');
  }
  const stats: MutableHealStats = { mtimeDrift: 0, orphan: 0, zeroCloud: 0, hashBackfill: 0 };

  healOrphanRecords(meta, localDir, stats, autoFix);
  stats.zeroCloud = countZeroCloud(meta);
  healMtimeDrift(meta, localDir, stats, autoFix);
  healHashBackfill(meta, localDir, stats, autoFix);

  if (autoFix) meta.save();
  return stats;
}
