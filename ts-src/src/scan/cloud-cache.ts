/**
 * Cached cloud scan: avoid full BFS when only a few files changed.
 *
 * Extracted from engine.ts to keep engine focused on orchestration.
 */
import { basename } from 'node:path';
import {
  asEpochSeconds,
  asRelPath,
  NoteDomain,
  type DirId,
  type FileId,
  type RelPath,
} from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { MetadataStore } from '../metadata/store.js';
import { cachedCloudName } from '../scan/name.js';
import {
  applyIncrementalChanges,
  overlayLiveMtimesFromRecent,
  toNum,
} from './cloud-cache-incremental.js';

import { seedMetadataFromDesktop } from '../metadata/desktop-data.js';

export const STATE_CLOUD_VERSION = 'last_cloud_version';
export const STATE_SCAN_TIME = 'last_scan_time';
export const STATE_LAST_FULL_SCAN = 'last_full_scan_time';

/**
 * Deletion-detection latency. `listRecent` only reports created/modified entries,
 * so applyIncrementalChanges can never drop a path — a cloud-side delete stays
 * invisible in the cached snapshot until the next full scan. This interval is
 * therefore the worst-case window in which sync reports a deleted cloud file as
 * still present (and `diagnose` reports it as `synced`). A full scan costs ~10s
 * on a 5.7k-file account, so 24h was far more staleness than the saving is worth.
 */
const FULL_SCAN_INTERVAL_SECONDS = 3600;

export interface CloudCacheDeps {
  api: {
    listRecent(limit: number): Promise<Record<string, unknown>[]>;
  };
  meta: MetadataStore;
  /** When true, skip desktop seed (e.g. in test mode with injected API). */
  skipDesktopSeed?: boolean;
  /** Skip listRecent if last scan was within this many seconds. Default: 60. */
  cacheTtlSeconds?: number | undefined;
}

const DEFAULT_CACHE_TTL_SECONDS = 60;

/**
 * Rebuild cloud_files from metadata (compatible with scanner format).
 * Loads file records with file_id AND directory records from the directories table.
 */
export function loadCloudFilesFromCache(meta: MetadataStore): Map<RelPath, CloudFile> | null {
  const summaries = meta.getCloudFileSummaries();
  if (summaries.size === 0) return null;

  const result = new Map<RelPath, CloudFile>();
  for (const [path, info] of summaries) {
    if (basename(path).includes('.conflict.')) continue;
    result.set(asRelPath(path), {
      id: info.fileId,
      parentId: info.parentId as DirId,
      name: cachedCloudName(path, info.domain),
      isDir: false,
      mtime: asEpochSeconds(info.cloudMtime),
      ctime: asEpochSeconds(info.createTime),
      domain: info.domain as NoteDomain,
    });
  }

  for (const [path, dir] of meta.getAllDirs()) {
    if (result.has(path)) continue;
    result.set(path, {
      id: dir.dirId,
      parentId: dir.parentId ?? ('' as DirId),
      name: basename(path),
      isDir: true,
      mtime: asEpochSeconds(0),
      ctime: asEpochSeconds(0),
      domain: NoteDomain.NOTE,
    });
  }

  return result.size > 0 ? result : null;
}

/**
 * Save cloud scan results to metadata + record version.
 * Stale path cleanup happens separately in engine (after move detection).
 */
export function saveScanVersion(
  meta: MetadataStore,
  cloudSnap: Map<RelPath, CloudFile>,
  maxVersion: number,
): void {
  meta.batch(() => {
    for (const [rel, info] of cloudSnap) {
      if (info.isDir) {
        meta.setDirInfo(rel, info.id as DirId, info.parentId);
      } else {
        meta.cacheCloudFileInfo(rel, {
          fileId: info.id as FileId,
          cloudMtime: info.mtime,
          parentId: info.parentId,
          domain: info.domain,
          createTime: info.ctime,
        });
      }
    }
    meta.setState(STATE_CLOUD_VERSION, String(maxVersion));
    const now = String(Math.floor(Date.now() / 1000));
    meta.setState(STATE_SCAN_TIME, now);
    meta.setState(STATE_LAST_FULL_SCAN, now);
  });
  meta.save();
}

/** Fetch cloud max version via listRecent. */
export async function fetchCurrentVersion(api: CloudCacheDeps['api']): Promise<number> {
  try {
    const recent = await api.listRecent(1);
    if (recent.length > 0) {
      const first = recent[0];
      const fe =
        first != null ? (first.fileEntry as Record<string, unknown> | undefined) : undefined;
      return toNum(fe?.version, 0);
    }
  } catch {
    /* ignore */
  }
  return 0;
}

function stampScanTime(meta: MetadataStore): void {
  meta.setState(STATE_SCAN_TIME, String(Math.floor(Date.now() / 1000)));
}

function tryTtlShortcut(meta: MetadataStore, ttl: number): Map<RelPath, CloudFile> | null {
  if (ttl <= 0) return null;
  // Synced rows keep baseline cloud_mtime in DB; TTL cache would feed classify stale mtimes.
  if (meta.hasSyncedFiles()) return null;
  const lastScanTime = meta.getStateInt(STATE_SCAN_TIME);
  if (lastScanTime <= 0) return null;
  const nowEpoch = Math.floor(Date.now() / 1000);
  if (nowEpoch - lastScanTime >= ttl) return null;
  return loadCloudFilesFromCache(meta);
}

function reconcileRecent(
  meta: MetadataStore,
  recent: Record<string, unknown>[],
  cachedVersion: number,
  cachedFiles: Map<RelPath, CloudFile> | null,
): Map<RelPath, CloudFile> | null {
  const needsLiveMtimes = meta.hasSyncedFiles();

  if (recent.length === 0) {
    if (needsLiveMtimes) return null;
    stampScanTime(meta);
    return cachedFiles;
  }
  const cloudMaxVersion = Math.max(
    ...recent.map((e) => {
      const fe = e.fileEntry as Record<string, unknown> | undefined;
      return toNum(fe?.version, 0);
    }),
  );
  if (cachedVersion >= cloudMaxVersion) {
    stampScanTime(meta);
    if (needsLiveMtimes && cachedFiles) {
      overlayLiveMtimesFromRecent(meta, cachedFiles, recent);
    }
    return cachedFiles;
  }
  const changed = recent.filter((e) => {
    const fe = e.fileEntry as Record<string, unknown> | undefined;
    return toNum(fe?.version, 0) > cachedVersion;
  });
  const allCovered = changed.length < recent.length;
  if (!allCovered || !cachedFiles) return null;

  applyIncrementalChanges(meta, cachedFiles, changed);
  meta.setState(STATE_CLOUD_VERSION, String(cloudMaxVersion));
  stampScanTime(meta);
  meta.save();
  return cachedFiles;
}

/**
 * Try to use cached cloud_files. Returns null when cache unavailable (full scan needed).
 *
 * Logic:
 * 1. No cached version → try desktop seed → still none → return null
 * 2. TTL shortcut: if scanned recently, skip the network call
 * 3. Call listRecent to get cloud changes since last cached version
 * 4. If no changes → use cache as-is
 * 5. If changes fit within listRecent window → incremental update
 * 6. If changes overflow → return null (need full scan)
 */
export async function tryCachedCloudScan(
  deps: CloudCacheDeps,
): Promise<Map<RelPath, CloudFile> | null> {
  const { api, meta } = deps;
  // Cache snap omits empty file_id rows. Using it as "the cloud" would
  // disagree with a live listing (mapped .note still exists). Force full scan.
  if (meta.hasEmptyFileId()) return null;

  const lastFullScan = meta.getStateInt(STATE_LAST_FULL_SCAN);
  const nowEpoch = Math.floor(Date.now() / 1000);
  if (lastFullScan > 0 && nowEpoch - lastFullScan >= FULL_SCAN_INTERVAL_SECONDS) {
    return null;
  }

  let cachedVersion = meta.getStateInt(STATE_CLOUD_VERSION);
  if (cachedVersion <= 0) {
    if (!deps.skipDesktopSeed && trySeedFromDesktop(meta)) {
      cachedVersion = meta.getStateInt(STATE_CLOUD_VERSION);
    }
    if (cachedVersion <= 0) return null;
  }

  const ttlResult = tryTtlShortcut(meta, deps.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS);
  if (ttlResult) return ttlResult;

  const [recentResult, cachedFiles] = await Promise.all([
    api.listRecent(30).catch(() => null),
    Promise.resolve(loadCloudFilesFromCache(meta)),
  ]);

  if (recentResult === null) {
    return meta.hasSyncedFiles() ? null : cachedFiles;
  }
  return reconcileRecent(meta, recentResult, cachedVersion, cachedFiles);
}

function trySeedFromDesktop(meta: MetadataStore): boolean {
  if (meta.getAllFiles().size > 0) return false;
  try {
    return seedMetadataFromDesktop(meta) > 0;
  } catch {
    return false;
  }
}
