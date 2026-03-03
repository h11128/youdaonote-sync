import type Database from 'better-sqlite3';
import type { ContentHash, DirId, FileId, NoteDomain } from '../types/common.js';
import type { MetadataRecord } from '../types/metadata.js';

export const FILE_META_COLS =
  'file_id, cloud_mtime, local_mtime, parent_id, domain, ' +
  'content_hash, create_time, last_sync_at, cloud_content_hash, original_domain';

export function rowToMetadata(row: Record<string, unknown>): MetadataRecord {
  return {
    fileId: (row['file_id'] as string || '') as FileId,
    cloudMtime: (row['cloud_mtime'] as number) ?? 0,
    localMtime: (row['local_mtime'] as number) ?? 0,
    contentHash: (row['content_hash'] as string || null) as ContentHash | null,
    cloudContentHash: (row['cloud_content_hash'] as string || null) as ContentHash | null,
    parentId: (row['parent_id'] as string || null) as DirId | null,
    domain: (row['domain'] as number ?? 1) as NoteDomain,
    lastSyncAt: (row['last_sync_at'] as number) ?? 0,
    originalDomain: (row['original_domain'] as number ?? null) as NoteDomain | null,
    createTime: (row['create_time'] as number) ?? 0,
  };
}

export function getFileId(db: Database.Database, path: string): FileId | null {
  const row = db.prepare('SELECT file_id FROM files WHERE path = ?').get(path) as { file_id: string } | undefined;
  return (row?.file_id || null) as FileId | null;
}

export function getFileInfo(db: Database.Database, path: string): MetadataRecord | null {
  const row = db.prepare(
    `SELECT ${FILE_META_COLS} FROM files WHERE path = ?`,
  ).get(path) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToMetadata(row);
}

export function markSynced(db: Database.Database, path: string, ts?: number): void {
  const now = ts ?? Math.floor(Date.now() / 1000);
  db.prepare('UPDATE files SET last_sync_at = ? WHERE path = ?').run(now, path);
}

export interface UpsertFileOpts {
  fileId: FileId;
  cloudMtime: number;
  localMtime: number;
  parentId?: DirId | null;
  domain?: NoteDomain | null;
  contentHash?: ContentHash | null;
  createTime?: number | null;
  lastSyncAt?: number;
  cloudContentHash?: ContentHash | null;
}

export function upsertFile(db: Database.Database, path: string, opts: UpsertFileOpts): void {
  db.prepare(
    'INSERT INTO files ' +
    '(path, file_id, cloud_mtime, local_mtime, parent_id, domain, ' +
    ' content_hash, create_time, last_sync_at, cloud_content_hash) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(path) DO UPDATE SET ' +
    '  file_id = excluded.file_id,' +
    '  cloud_mtime = excluded.cloud_mtime,' +
    '  local_mtime = excluded.local_mtime,' +
    '  parent_id = COALESCE(excluded.parent_id, files.parent_id),' +
    '  domain = COALESCE(excluded.domain, files.domain),' +
    '  content_hash = COALESCE(excluded.content_hash, files.content_hash),' +
    '  create_time = CASE WHEN excluded.create_time IS NOT NULL AND excluded.create_time > 0 THEN excluded.create_time ELSE files.create_time END,' +
    '  last_sync_at = CASE WHEN excluded.last_sync_at > 0 THEN excluded.last_sync_at ELSE files.last_sync_at END,' +
    '  cloud_content_hash = COALESCE(excluded.cloud_content_hash, files.cloud_content_hash)',
  ).run(
    path,
    opts.fileId || '',
    opts.cloudMtime,
    opts.localMtime,
    opts.parentId ?? null,
    opts.domain ?? null,
    opts.contentHash ?? null,
    opts.createTime && opts.createTime > 0 ? opts.createTime : null,
    opts.lastSyncAt ?? 0,
    opts.cloudContentHash ?? null,
  );
}

export function cacheCloudFileInfo(
  db: Database.Database,
  path: string,
  opts: {
    fileId: FileId;
    cloudMtime: number;
    parentId?: DirId | null;
    domain?: NoteDomain | null;
    createTime?: number | null;
  },
): void {
  db.prepare(
    'INSERT INTO files (path, file_id, cloud_mtime, local_mtime, parent_id, domain, create_time) ' +
    'VALUES (?, ?, ?, 0, ?, ?, ?) ' +
    'ON CONFLICT(path) DO UPDATE SET ' +
    '  file_id = excluded.file_id,' +
    '  parent_id = COALESCE(excluded.parent_id, files.parent_id),' +
    '  domain = COALESCE(excluded.domain, files.domain),' +
    '  create_time = CASE WHEN excluded.create_time IS NOT NULL AND excluded.create_time > 0 THEN excluded.create_time ELSE files.create_time END',
  ).run(
    path,
    opts.fileId || '',
    opts.cloudMtime,
    opts.parentId ?? null,
    opts.domain ?? null,
    opts.createTime && opts.createTime > 0 ? opts.createTime : null,
  );
}

export function removeFileInfo(db: Database.Database, path: string): void {
  db.prepare('DELETE FROM files WHERE path = ?').run(path);
}

export function renamePath(db: Database.Database, oldPath: string, newPath: string): boolean {
  try {
    const result = db.prepare('UPDATE files SET path = ? WHERE path = ?').run(newPath, oldPath);
    return result.changes > 0;
  } catch (e: unknown) {
    if (String(e).includes('UNIQUE constraint')) {
      db.prepare('DELETE FROM files WHERE path = ?').run(oldPath);
      return false;
    }
    throw e;
  }
}

export function getAllFiles(db: Database.Database): Map<string, MetadataRecord> {
  const rows = db.prepare(`SELECT path, ${FILE_META_COLS} FROM files`).all() as Array<Record<string, unknown>>;
  const result = new Map<string, MetadataRecord>();
  for (const row of rows) {
    result.set(row['path'] as string, rowToMetadata(row));
  }
  return result;
}

export function findByFileId(db: Database.Database, fileId: FileId): string | null {
  const row = db.prepare('SELECT path FROM files WHERE file_id = ?').get(fileId) as { path: string } | undefined;
  return row?.path ?? null;
}

export function findCloudFileByHash(
  db: Database.Database,
  contentHash: ContentHash,
  excludePath?: string,
): string | null {
  if (!contentHash) return null;
  const row = db.prepare(
    "SELECT path FROM files WHERE content_hash = ? AND file_id != '' AND path != ? LIMIT 1",
  ).get(contentHash, excludePath ?? '') as { path: string } | undefined;
  return row?.path ?? null;
}

export function updateContentHash(db: Database.Database, path: string, contentHash: ContentHash): void {
  db.prepare('UPDATE files SET content_hash = ? WHERE path = ?').run(contentHash || '', path);
}

export function getContentHash(db: Database.Database, path: string): ContentHash | null {
  const row = db.prepare('SELECT content_hash FROM files WHERE path = ?').get(path) as { content_hash: string | null } | undefined;
  return (row?.content_hash || null) as ContentHash | null;
}

export function setCloudContentHash(db: Database.Database, path: string, cloudHash: ContentHash): void {
  db.prepare('UPDATE files SET cloud_content_hash = ? WHERE path = ?').run(cloudHash, path);
}

export function getStaleFilePaths(db: Database.Database, cutoffTs: number): string[] {
  const rows = db.prepare('SELECT path FROM files WHERE last_sync_at > 0 AND last_sync_at < ?').all(cutoffTs) as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

export function updateLocalMtime(db: Database.Database, path: string, mtime: number): void {
  db.prepare('UPDATE files SET local_mtime = ? WHERE path = ?').run(mtime, path);
}

export function updateOriginalDomain(db: Database.Database, path: string, domain: NoteDomain): void {
  db.prepare(
    'UPDATE files SET original_domain = ? WHERE path = ? AND original_domain IS NULL',
  ).run(domain, path);
}

export interface CloudFileSummary {
  fileId: FileId;
  cloudMtime: number;
  parentId: string;
  domain: number;
  createTime: number;
}

/**
 * Return all file records that have a non-empty file_id (for scan cache rebuild).
 */
export function getCloudFileSummaries(db: Database.Database): Map<string, CloudFileSummary> {
  const rows = db.prepare(
    "SELECT path, file_id, cloud_mtime, parent_id, domain, create_time FROM files WHERE file_id != ''",
  ).all() as Array<Record<string, unknown>>;
  const result = new Map<string, CloudFileSummary>();
  for (const row of rows) {
    result.set(row['path'] as string, {
      fileId: (row['file_id'] as string || '') as FileId,
      cloudMtime: (row['cloud_mtime'] as number) || 0,
      parentId: (row['parent_id'] as string) || '',
      domain: (row['domain'] as number) || 0,
      createTime: (row['create_time'] as number) || 0,
    });
  }
  return result;
}

/**
 * Return paths that have a non-empty file_id but are not in activePaths.
 * Used to clean up metadata for files that no longer exist in cloud.
 */
export function getStaleCloudPaths(db: Database.Database, activePaths: ReadonlySet<string>): string[] {
  const rows = db.prepare("SELECT path FROM files WHERE file_id != ''").all() as Array<{ path: string }>;
  return rows.filter((r) => !activePaths.has(r.path)).map((r) => r.path);
}

/**
 * Clear the cloud file_id for a path (mark as local-only record).
 */
export function clearCloudId(db: Database.Database, path: string): void {
  db.prepare("UPDATE files SET file_id = '' WHERE path = ?").run(path);
}
