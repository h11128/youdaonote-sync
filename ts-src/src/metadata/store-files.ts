import type Database from 'better-sqlite3';
import {
  asEpochSeconds,
  asRelPath,
  type ContentHash,
  type DirId,
  type EpochSeconds,
  type FileId,
  type NoteDomain,
  type RelPath,
} from '../types/common.js';
import type { MetadataRecord } from '../types/metadata.js';

export const FILE_META_COLS =
  'file_id, cloud_mtime, local_mtime, parent_id, domain, ' +
  'content_hash, create_time, last_sync_at, cloud_content_hash, original_domain';

function getNum(val: unknown, fallback: number): number {
  return typeof val === 'number' && !Number.isNaN(val) ? val : fallback;
}

function getStrOrNull(val: unknown): string | null {
  if (val == null) return null;
  return typeof val === 'string' ? val : null;
}

export function rowToMetadata(row: Record<string, unknown>): MetadataRecord {
  return {
    fileId: (getStrOrNull(row.file_id) ?? '') as FileId,
    cloudMtime: asEpochSeconds(getNum(row.cloud_mtime, 0)),
    localMtime: asEpochSeconds(getNum(row.local_mtime, 0)),
    contentHash: getStrOrNull(row.content_hash) as ContentHash | null,
    cloudContentHash: getStrOrNull(row.cloud_content_hash) as ContentHash | null,
    parentId: getStrOrNull(row.parent_id) as DirId | null,
    domain: getNum(row.domain, 1) as NoteDomain,
    lastSyncAt: asEpochSeconds(getNum(row.last_sync_at, 0)),
    originalDomain: (row.original_domain != null
      ? getNum(row.original_domain, 1)
      : null) as NoteDomain | null,
    createTime: asEpochSeconds(getNum(row.create_time, 0)),
  };
}

export function getFileId(db: Database.Database, path: RelPath): FileId | null {
  const row = db.prepare('SELECT file_id FROM files WHERE path = ?').get(path) as
    | { file_id: string }
    | undefined;
  return (row?.file_id ?? null) as FileId | null;
}

export function getFileInfo(db: Database.Database, path: RelPath): MetadataRecord | null {
  const row = db.prepare(`SELECT ${FILE_META_COLS} FROM files WHERE path = ?`).get(path) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return rowToMetadata(row);
}

export function markSynced(db: Database.Database, path: RelPath, ts?: EpochSeconds): void {
  const now = ts ?? Math.floor(Date.now() / 1000);
  db.prepare('UPDATE files SET last_sync_at = ? WHERE path = ?').run(now, path);
}

export interface UpsertFileOpts {
  fileId: FileId;
  cloudMtime: EpochSeconds;
  localMtime: EpochSeconds;
  parentId?: DirId | null;
  domain?: NoteDomain | null;
  contentHash?: ContentHash | null;
  createTime?: EpochSeconds | null;
  lastSyncAt?: EpochSeconds;
  cloudContentHash?: ContentHash | null;
}

export function upsertFile(db: Database.Database, path: RelPath, opts: UpsertFileOpts): void {
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
    opts.fileId,
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
  path: RelPath,
  opts: {
    fileId: FileId;
    cloudMtime: EpochSeconds;
    parentId?: DirId | null;
    domain?: NoteDomain | null;
    createTime?: EpochSeconds | null;
  },
): void {
  db.prepare(
    'INSERT INTO files (path, file_id, cloud_mtime, local_mtime, parent_id, domain, create_time) ' +
      'VALUES (?, ?, ?, 0, ?, ?, ?) ' +
      'ON CONFLICT(path) DO UPDATE SET ' +
      '  file_id = excluded.file_id,' +
      '  cloud_mtime = CASE WHEN files.last_sync_at > 0 THEN files.cloud_mtime ELSE excluded.cloud_mtime END,' +
      '  parent_id = COALESCE(excluded.parent_id, files.parent_id),' +
      '  domain = COALESCE(excluded.domain, files.domain),' +
      '  create_time = CASE WHEN excluded.create_time IS NOT NULL AND excluded.create_time > 0 THEN excluded.create_time ELSE files.create_time END',
  ).run(
    path,
    opts.fileId,
    opts.cloudMtime,
    opts.parentId ?? null,
    opts.domain ?? null,
    opts.createTime && opts.createTime > 0 ? opts.createTime : null,
  );
}

export function removeFileInfo(db: Database.Database, path: RelPath): void {
  db.prepare('DELETE FROM files WHERE path = ?').run(path);
}

export function renamePath(db: Database.Database, oldPath: RelPath, newPath: RelPath): boolean {
  try {
    const result = db.prepare('UPDATE files SET path = ? WHERE path = ?').run(newPath, oldPath);
    if (result.changes === 0) return false;

    db.prepare('UPDATE OR IGNORE file_base SET path = ? WHERE path = ?').run(newPath, oldPath);
    db.prepare('DELETE FROM file_base WHERE path = ?').run(oldPath);

    db.prepare('UPDATE OR IGNORE file_refs SET source_path = ? WHERE source_path = ?').run(
      newPath,
      oldPath,
    );
    db.prepare('DELETE FROM file_refs WHERE source_path = ?').run(oldPath);

    return true;
  } catch (e: unknown) {
    if (String(e).includes('UNIQUE constraint')) {
      db.prepare('DELETE FROM files WHERE path = ?').run(oldPath);
      db.prepare('DELETE FROM file_base WHERE path = ?').run(oldPath);
      db.prepare('DELETE FROM file_refs WHERE source_path = ?').run(oldPath);
      return false;
    }
    throw e;
  }
}

export function hasEmptyFileId(db: Database.Database): boolean {
  const row = db.prepare("SELECT 1 FROM files WHERE file_id = '' LIMIT 1").get();
  return row != null;
}

export function getAllFiles(db: Database.Database): Map<RelPath, MetadataRecord> {
  const rows = db.prepare(`SELECT path, ${FILE_META_COLS} FROM files`).all() as Record<
    string,
    unknown
  >[];
  const result = new Map<RelPath, MetadataRecord>();
  for (const row of rows) {
    result.set(asRelPath(row.path as string), rowToMetadata(row));
  }
  return result;
}

export function findByFileId(db: Database.Database, fileId: FileId): RelPath | null {
  const row = db.prepare('SELECT path FROM files WHERE file_id = ?').get(fileId) as
    | { path: string }
    | undefined;
  return row?.path != null ? asRelPath(row.path) : null;
}

export function findCloudFileByHash(
  db: Database.Database,
  contentHash: ContentHash,
  excludePath?: RelPath,
): RelPath | null {
  if (!contentHash) return null;
  const row = db
    .prepare(
      "SELECT path FROM files WHERE content_hash = ? AND file_id != '' AND path != ? LIMIT 1",
    )
    .get(contentHash, excludePath ?? '') as { path: string } | undefined;
  return row?.path != null ? asRelPath(row.path) : null;
}

export function updateContentHash(
  db: Database.Database,
  path: RelPath,
  contentHash: ContentHash,
): void {
  db.prepare('UPDATE files SET content_hash = ? WHERE path = ?').run(contentHash, path);
}

export function getContentHash(db: Database.Database, path: RelPath): ContentHash | null {
  const row = db.prepare('SELECT content_hash FROM files WHERE path = ?').get(path) as
    | { content_hash: string | null }
    | undefined;
  return (row?.content_hash ?? null) as ContentHash | null;
}

export function setCloudContentHash(
  db: Database.Database,
  path: RelPath,
  cloudHash: ContentHash,
): void {
  db.prepare('UPDATE files SET cloud_content_hash = ? WHERE path = ?').run(cloudHash, path);
}

export function getStaleFilePaths(db: Database.Database, cutoffTs: EpochSeconds): RelPath[] {
  const rows = db
    .prepare('SELECT path FROM files WHERE last_sync_at > 0 AND last_sync_at < ?')
    .all(cutoffTs as number) as { path: string }[];
  return rows.map((r) => asRelPath(r.path));
}

export function updateLocalMtime(db: Database.Database, path: RelPath, mtime: EpochSeconds): void {
  db.prepare('UPDATE files SET local_mtime = ? WHERE path = ?').run(mtime, path);
}

export function updateOriginalDomain(
  db: Database.Database,
  path: RelPath,
  domain: NoteDomain,
): void {
  db.prepare('UPDATE files SET original_domain = ? WHERE path = ? AND original_domain IS NULL').run(
    domain,
    path,
  );
}

export interface CloudFileSummary {
  fileId: FileId;
  cloudMtime: EpochSeconds;
  parentId: string;
  domain: number;
  createTime: EpochSeconds;
}

/**
 * Return all file records that have a non-empty file_id (for scan cache rebuild).
 */
export function getCloudFileSummaries(db: Database.Database): Map<RelPath, CloudFileSummary> {
  const rows = db
    .prepare(
      "SELECT path, file_id, cloud_mtime, parent_id, domain, create_time FROM files WHERE file_id != ''",
    )
    .all() as Record<string, unknown>[];
  const result = new Map<RelPath, CloudFileSummary>();
  for (const row of rows) {
    result.set(asRelPath(row.path as string), {
      fileId: (getStrOrNull(row.file_id) ?? '') as FileId,
      cloudMtime: asEpochSeconds(getNum(row.cloud_mtime, 0)),
      parentId: getStrOrNull(row.parent_id) ?? '',
      domain: getNum(row.domain, 0),
      createTime: asEpochSeconds(getNum(row.create_time, 0)),
    });
  }
  return result;
}

/**
 * Return paths that have a non-empty file_id but are not in activePaths.
 * Used to clean up metadata for files that no longer exist in cloud.
 */
export function getStaleCloudPaths(
  db: Database.Database,
  activePaths: ReadonlySet<RelPath>,
): RelPath[] {
  const rows = db.prepare("SELECT path FROM files WHERE file_id != ''").all() as {
    path: string;
  }[];
  return rows.filter((r) => !activePaths.has(asRelPath(r.path))).map((r) => asRelPath(r.path));
}

// clearCloudId removed (2026-08-09): soft-clear left empty-file_id zombies.
// Use removeFileInfo / cleanupStalePaths / purgeNonSyncableFileRows instead.
