/**
 * Cached cloud scan: avoid full BFS when only a few files changed.
 *
 * Extracted from engine.ts to keep engine focused on orchestration.
 */
import { basename } from 'node:path';
import type { DirId, FileId, NoteDomain } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { MetadataStore } from '../metadata/store.js';

import { seedMetadataFromDesktop } from '../desktop-data.js';

export const STATE_CLOUD_VERSION = 'last_cloud_version';
export const STATE_SCAN_TIME = 'last_scan_time';

export interface CloudCacheDeps {
  api: {
    listRecent(limit: number): Promise<Array<Record<string, unknown>>>;
  };
  meta: MetadataStore;
  /** When true, skip desktop seed (e.g. in test mode with injected API). */
  skipDesktopSeed?: boolean;
}

/**
 * Rebuild cloud_files from metadata (compatible with scanner format).
 * Only loads file records with file_id. Directories are excluded to avoid
 * phantom downloads from stale directory records.
 */
export function loadCloudFilesFromCache(meta: MetadataStore): Map<string, CloudFile> | null {
  const summaries = meta.getCloudFileSummaries();
  if (!summaries || summaries.size === 0) return null;

  const result = new Map<string, CloudFile>();
  for (const [path, info] of summaries) {
    if (basename(path).includes('.conflict.')) continue;
    result.set(path, {
      id: info.fileId,
      parentId: (info.parentId || '') as DirId,
      name: basename(path),
      isDir: false,
      mtime: info.cloudMtime,
      ctime: info.createTime || 0,
      domain: (info.domain || 0) as NoteDomain,
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
  cloudSnap: Map<string, CloudFile>,
  maxVersion: number,
): void {
  meta.batch(() => {
    for (const [rel, info] of cloudSnap) {
      if (info.isDir) {
        meta.setDirInfo(rel, info.id as DirId, info.parentId as DirId);
      } else {
        meta.cacheCloudFileInfo(rel, {
          fileId: info.id as FileId,
          cloudMtime: info.mtime,
          parentId: info.parentId,
          domain: info.domain ?? 0,
          createTime: info.ctime ?? 0,
        });
      }
    }
    meta.setState(STATE_CLOUD_VERSION, String(maxVersion));
    meta.setState(STATE_SCAN_TIME, String(Math.floor(Date.now() / 1000)));
  });
  meta.save();
}

/** Fetch cloud max version via listRecent. */
export async function fetchCurrentVersion(
  api: CloudCacheDeps['api'],
): Promise<number> {
  try {
    const recent = await api.listRecent(1);
    if (recent.length > 0) {
      const fe = recent[0]!['fileEntry'] as Record<string, unknown> | undefined;
      return (fe?.['version'] as number) || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * Try to use cached cloud_files. Returns null when cache unavailable (full scan needed).
 *
 * Logic:
 * 1. No cached version → try desktop seed → still none → return null
 * 2. Call listRecent to get cloud changes since last cached version
 * 3. If no changes → use cache as-is
 * 4. If changes fit within listRecent window → incremental update
 * 5. If changes overflow → return null (need full scan)
 */
export async function tryCachedCloudScan(deps: CloudCacheDeps): Promise<Map<string, CloudFile> | null> {
  const { api, meta } = deps;
  let cachedVersion = meta.getStateInt(STATE_CLOUD_VERSION);
  if (cachedVersion <= 0) {
    if (!deps.skipDesktopSeed && trySeedFromDesktop(meta)) {
      cachedVersion = meta.getStateInt(STATE_CLOUD_VERSION);
    }
    if (cachedVersion <= 0) return null;
  }

  let recent: Array<Record<string, unknown>>;
  try {
    recent = await api.listRecent(30);
  } catch {
    return loadCloudFilesFromCache(meta) ?? null;
  }

  if (recent.length === 0) {
    return loadCloudFilesFromCache(meta);
  }

  const cloudMaxVersion = Math.max(
    ...recent.map((e) => {
      const fe = e['fileEntry'] as Record<string, unknown> | undefined;
      return (fe?.['version'] as number) || 0;
    }),
  );

  if (cachedVersion >= cloudMaxVersion) {
    return loadCloudFilesFromCache(meta);
  }

  const changed = recent.filter((e) => {
    const fe = e['fileEntry'] as Record<string, unknown> | undefined;
    return ((fe?.['version'] as number) || 0) > cachedVersion;
  });
  const allCovered = changed.length < recent.length;

  if (!allCovered) return null;

  const cached = loadCloudFilesFromCache(meta);
  if (!cached) return null;

  applyIncrementalChanges(meta, cached, changed);
  meta.setState(STATE_CLOUD_VERSION, String(cloudMaxVersion));
  meta.setState(STATE_SCAN_TIME, String(Math.floor(Date.now() / 1000)));
  meta.save();

  return cached;
}

/**
 * Apply listRecent changes to the cached cloud_files and metadata.
 */
function applyIncrementalChanges(
  meta: MetadataStore,
  cloudFiles: Map<string, CloudFile>,
  changedEntries: Array<Record<string, unknown>>,
): void {
  meta.batch(() => {
    for (const entry of changedEntries) {
      const fe = entry['fileEntry'] as Record<string, unknown> | undefined;
      if (!fe) continue;
      const fid = (fe['id'] as string) || '';
      const name = (fe['name'] as string) || '';
      if (!fid || !name) continue;

      const isDir = Boolean(fe['dir']);
      const parentId = (fe['parentId'] as string) || '';

      const existingPath = isDir
        ? meta.findByDirId(fid as DirId)
        : meta.findByFileId(fid as FileId);

      if (isDir) {
        if (existingPath) {
          cloudFiles.set(existingPath, {
            id: fid as DirId, parentId: parentId as DirId, name,
            isDir: true, mtime: 0, ctime: 0, domain: 0 as NoteDomain,
          });
          meta.setDirInfo(existingPath, fid as DirId, parentId as DirId);
        }
      } else {
        const mtime = (fe['modifyTimeForSort'] as number) || 0;
        const ctime = (fe['createTimeForSort'] as number) || 0;
        const domain = ((fe['domain'] as number) || 0) as NoteDomain;
        const info: CloudFile = {
          id: fid as FileId, parentId: parentId as DirId, name,
          isDir: false, mtime, ctime, domain,
        };
        if (existingPath) {
          cloudFiles.set(existingPath, info);
          meta.cacheCloudFileInfo(existingPath, {
            fileId: fid as FileId,
            cloudMtime: mtime,
            parentId: parentId as DirId,
            domain,
            createTime: ctime,
          });
        }
      }
    }
  });
}

function trySeedFromDesktop(meta: MetadataStore): boolean {
  if (meta.getAllFiles().size > 0) return false;
  try {
    return seedMetadataFromDesktop(meta) > 0;
  } catch { return false; }
}
