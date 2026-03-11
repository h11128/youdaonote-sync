/**
 * Cached cloud scan: avoid full BFS when only a few files changed.
 *
 * Extracted from engine.ts to keep engine focused on orchestration.
 */
import { basename } from 'node:path';
import {
  asEpochSeconds,
  asRelPath,
  joinRelPath,
  type DirId,
  type FileId,
  type NoteDomain,
  type RelPath,
} from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { MetadataStore } from '../metadata/store.js';
import { mapCloudName, sanitizeFilename } from '../scan/name.js';

import { seedMetadataFromDesktop } from '../desktop-data.js';

export const STATE_CLOUD_VERSION = 'last_cloud_version';
export const STATE_SCAN_TIME = 'last_scan_time';

export interface CloudCacheDeps {
  api: {
    listRecent(limit: number): Promise<Record<string, unknown>[]>;
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
export function loadCloudFilesFromCache(meta: MetadataStore): Map<RelPath, CloudFile> | null {
  const summaries = meta.getCloudFileSummaries();
  if (summaries.size === 0) return null;

  const result = new Map<RelPath, CloudFile>();
  for (const [path, info] of summaries) {
    if (basename(path).includes('.conflict.')) continue;
    result.set(asRelPath(path), {
      id: info.fileId,
      parentId: info.parentId as DirId,
      name: basename(path),
      isDir: false,
      mtime: asEpochSeconds(info.cloudMtime),
      ctime: asEpochSeconds(info.createTime),
      domain: info.domain as NoteDomain,
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
    meta.setState(STATE_SCAN_TIME, String(Math.floor(Date.now() / 1000)));
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
export async function tryCachedCloudScan(
  deps: CloudCacheDeps,
): Promise<Map<RelPath, CloudFile> | null> {
  const { api, meta } = deps;
  let cachedVersion = meta.getStateInt(STATE_CLOUD_VERSION);
  if (cachedVersion <= 0) {
    if (!deps.skipDesktopSeed && trySeedFromDesktop(meta)) {
      cachedVersion = meta.getStateInt(STATE_CLOUD_VERSION);
    }
    if (cachedVersion <= 0) return null;
  }

  let recent: Record<string, unknown>[];
  try {
    recent = await api.listRecent(30);
  } catch {
    return loadCloudFilesFromCache(meta);
  }

  if (recent.length === 0) {
    return loadCloudFilesFromCache(meta);
  }

  const cloudMaxVersion = Math.max(
    ...recent.map((e) => {
      const fe = e.fileEntry as Record<string, unknown> | undefined;
      return toNum(fe?.version, 0);
    }),
  );

  if (cachedVersion >= cloudMaxVersion) {
    return loadCloudFilesFromCache(meta);
  }

  const changed = recent.filter((e) => {
    const fe = e.fileEntry as Record<string, unknown> | undefined;
    return toNum(fe?.version, 0) > cachedVersion;
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
interface DirEntryParams {
  meta: MetadataStore;
  cloudFiles: Map<RelPath, CloudFile>;
  fid: string;
  name: string;
  parentId: string;
}

function toNum(val: unknown, fallback: number): number {
  const n = Number(val);
  return Number.isNaN(n) ? fallback : n;
}

function toStr(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return '';
}

function resolveNewPath(meta: MetadataStore, parentId: string, name: string): RelPath | null {
  if (!parentId) return null;
  const parentPath = meta.findByDirId(parentId as DirId);
  if (parentPath == null) return null;
  return parentPath ? joinRelPath(asRelPath(parentPath), name) : asRelPath(name);
}

function processDirEntry(opts: DirEntryParams): void {
  const { meta, cloudFiles, fid, name, parentId } = opts;
  const existingPath = meta.findByDirId(fid as DirId);
  const relPath =
    (existingPath != null ? asRelPath(existingPath) : null) ??
    resolveNewPath(meta, parentId, sanitizeFilename(name));
  if (!relPath) return;

  cloudFiles.set(relPath, {
    id: fid as DirId,
    parentId: parentId as DirId,
    name,
    isDir: true,
    mtime: asEpochSeconds(0),
    ctime: asEpochSeconds(0),
    domain: 0 as NoteDomain,
  });
  meta.setDirInfo(relPath, fid as DirId, parentId as DirId);
}

interface FileEntryParams extends DirEntryParams {
  fe: Record<string, unknown>;
}

function processFileEntry(opts: FileEntryParams): void {
  const { meta, cloudFiles, fe, fid, name, parentId } = opts;
  const mtime = toNum(fe.modifyTimeForSort, 0);
  const ctime = toNum(fe.createTimeForSort, 0);
  const domain = toNum(fe.domain, 0) as NoteDomain;
  const existingPath = meta.findByFileId(fid as FileId);
  const relPath =
    (existingPath != null ? asRelPath(existingPath) : null) ??
    resolveNewPath(meta, parentId, mapCloudName(name));
  if (!relPath) return;

  const info: CloudFile = {
    id: fid as FileId,
    parentId: parentId as DirId,
    name,
    isDir: false,
    mtime: asEpochSeconds(mtime),
    ctime: asEpochSeconds(ctime),
    domain,
  };
  cloudFiles.set(relPath, info);
  meta.cacheCloudFileInfo(relPath, {
    fileId: fid as FileId,
    cloudMtime: asEpochSeconds(mtime),
    parentId: parentId as DirId,
    domain,
    createTime: asEpochSeconds(ctime),
  });
}

function applyIncrementalChanges(
  meta: MetadataStore,
  cloudFiles: Map<RelPath, CloudFile>,
  changedEntries: Record<string, unknown>[],
): void {
  meta.batch(() => {
    for (const entry of changedEntries) {
      const fe = entry.fileEntry as Record<string, unknown> | undefined;
      if (!fe) continue;
      const fid = toStr(fe.id);
      const name = toStr(fe.name);
      if (!fid || !name) continue;

      const isDir = Boolean(fe.dir);
      const parentId = toStr(fe.parentId);

      if (isDir) {
        processDirEntry({ meta, cloudFiles, fid, name, parentId });
      } else {
        processFileEntry({ meta, cloudFiles, fe, fid, name, parentId });
      }
    }
  });
}

function trySeedFromDesktop(meta: MetadataStore): boolean {
  if (meta.getAllFiles().size > 0) return false;
  try {
    return seedMetadataFromDesktop(meta) > 0;
  } catch {
    return false;
  }
}
