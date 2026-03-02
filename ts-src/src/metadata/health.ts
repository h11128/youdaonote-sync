import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MetadataStore } from './store.js';
import { computeContentHashFromFile } from '../hash.js';

export enum VerifyIssueType {
  ORPHAN = 'orphan',
  HASH_MISMATCH = 'hash_mismatch',
  ORPHAN_DIR = 'orphan_dir',
}

export interface VerifyIssue {
  readonly path: string;
  readonly type: VerifyIssueType;
  readonly detail: string;
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
export function verify(
  meta: MetadataStore,
  localDir: string,
  autoFix = false,
): VerifyIssue[] {
  if (!localDir || typeof localDir !== 'string') {
    throw new Error('verify: localDir must be a non-empty string');
  }
  const issues: VerifyIssue[] = [];

  const allFiles = meta.getAllFiles();
  for (const [path, record] of allFiles) {
    const full = join(localDir, path);
    if (!existsSync(full)) {
      if (record.fileId) {
        issues.push({ path, type: VerifyIssueType.ORPHAN, detail: 'local file missing but has file_id' });
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

  const allDirs = meta.getAllDirs();
  for (const [path] of allDirs) {
    const full = join(localDir, path);
    if (!existsSync(full)) {
      issues.push({ path, type: VerifyIssueType.ORPHAN_DIR, detail: 'local directory missing' });
    }
  }

  if (autoFix && issues.length > 0) {
    meta.batch(() => {
      for (const issue of issues) {
        if (issue.type === VerifyIssueType.HASH_MISMATCH) {
          const actual = computeContentHashFromFile(join(localDir, issue.path));
          if (actual) meta.updateContentHash(issue.path, actual);
        } else if (issue.type === VerifyIssueType.ORPHAN_DIR) {
          meta.removeDir(issue.path);
        }
      }
    });
  }

  return issues;
}

export interface GcStats {
  readonly files: number;
  readonly dirs: number;
  readonly logs: number;
  readonly bases: number;
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
export function gc(
  meta: MetadataStore,
  localDir: string,
  maxLogAgeDays = 90,
): GcStats {
  if (!localDir || typeof localDir !== 'string') {
    throw new Error('gc: localDir must be a non-empty string');
  }
  const stats: MutableGcStats = { files: 0, dirs: 0, logs: 0, bases: 0 };
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 30 * 86400;
  const logCutoff = now - maxLogAgeDays * 86400;

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

/**
 * Lightweight self-healing pass run before each sync.
 *
 * Detects and optionally repairs:
 * 1. local_mtime drift (os mtime differs but content_hash unchanged → update mtime)
 * 2. orphan records (no local file, no file_id → delete)
 * 3. cloud_mtime = 0 (legacy migration leftover → log warning)
 * 4. content_hash missing (has file_id + local_mtime but no hash → backfill)
 */
export function heal(
  meta: MetadataStore,
  localDir: string,
  autoFix = false,
): HealStats {
  if (!localDir || typeof localDir !== 'string') {
    throw new Error('heal: localDir must be a non-empty string');
  }
  const stats: MutableHealStats = { mtimeDrift: 0, orphan: 0, zeroCloud: 0, hashBackfill: 0 };
  const allFiles = meta.getAllFiles();

  for (const [path, record] of allFiles) {
    const full = join(localDir, path);
    const exists = existsSync(full);

    if (!exists && !record.fileId) {
      stats.orphan++;
      if (autoFix) meta.removeFileInfo(path);
      continue;
    }
    if (!exists) continue;

    const actualMtime = Math.floor(statSync(full).mtimeMs / 1000);

    if (record.localMtime && actualMtime !== record.localMtime && record.contentHash) {
      const actualHash = computeContentHashFromFile(full);
      if (actualHash && actualHash === record.contentHash) {
        stats.mtimeDrift++;
        if (autoFix) meta.updateLocalMtime(path, actualMtime);
      }
    }

    if (record.cloudMtime === 0 && record.fileId) {
      stats.zeroCloud++;
    }

    if (!record.contentHash && record.fileId && record.localMtime > 0
      && actualMtime === record.localMtime) {
      const actualHash = computeContentHashFromFile(full);
      if (actualHash) {
        stats.hashBackfill++;
        if (autoFix) meta.updateContentHash(path, actualHash);
      }
    }
  }

  if (autoFix) meta.save();
  return stats;
}
