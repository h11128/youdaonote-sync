import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContentHash, DirId, FileId, NoteDomain } from '../types/common.js';
import type { MetadataRecord } from '../types/metadata.js';
import { runAllMigrations } from './migrations.js';
import { sanitizeFilename } from '../scan/name.js';
import { normalizeSep } from '../scan/name.js';

const FILE_META_COLS =
  "file_id, cloud_mtime, local_mtime, parent_id, domain, " +
  "content_hash, create_time, last_sync_at, cloud_content_hash, original_domain";

/**
 * SQLite-backed metadata store for sync state.
 *
 * Wraps better-sqlite3 with the same schema as the Python SyncMetadata class,
 * allowing the TS and Python versions to share the same database file.
 */
export class MetadataStore {
  private db: Database.Database;
  private saveCount = 0;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (dir) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    const accessor = {
      getState: (key: string) => this.getState(key),
      setState: (key: string, value: string) => this.setState(key, value),
    };
    runAllMigrations(this.db, accessor, sanitizeFilename);
  }

  close(): void {
    this.db.close();
  }

  // ========== Path normalization ==========

  private normalizePath(localPath: string): string {
    return normalizeSep(localPath);
  }

  // ========== File methods ==========

  getFileId(localPath: string): FileId | null {
    const path = this.normalizePath(localPath);
    const row = this.db.prepare(
      "SELECT file_id FROM files WHERE path = ?",
    ).get(path) as { file_id: string } | undefined;
    return (row?.file_id || null) as FileId | null;
  }

  getFileInfo(localPath: string): MetadataRecord | null {
    const path = this.normalizePath(localPath);
    const row = this.db.prepare(
      `SELECT ${FILE_META_COLS} FROM files WHERE path = ?`,
    ).get(path) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToMetadata(row);
  }

  markSynced(localPath: string, ts?: number): void {
    const path = this.normalizePath(localPath);
    const now = ts ?? Math.floor(Date.now() / 1000);
    this.db.prepare(
      "UPDATE files SET last_sync_at = ? WHERE path = ?",
    ).run(now, path);
  }

  setFileInfo(
    localPath: string,
    opts: {
      fileId: FileId;
      cloudMtime: number;
      localMtime: number;
      parentId?: DirId | null;
      domain?: NoteDomain | null;
      contentHash?: ContentHash | null;
      createTime?: number | null;
      lastSyncAt?: number;
      cloudContentHash?: ContentHash | null;
    },
  ): void {
    if (!localPath) throw new Error("localPath must not be empty");
    const path = this.normalizePath(localPath);
    this.upsertFile(path, opts);
  }

  recordSync(
    localPath: string,
    opts: {
      fileId: FileId;
      cloudMtime: number;
      localMtime: number;
      parentId?: DirId | null;
      domain?: NoteDomain | null;
      contentHash?: ContentHash | null;
      cloudContentHash?: ContentHash | null;
      originalDomain?: NoteDomain | null;
      createTime?: number | null;
      action?: string;
      direction?: string;
      oldHash?: ContentHash | null;
      detail?: string;
    },
  ): void {
    if (!localPath) throw new Error("localPath must not be empty");
    const now = Math.floor(Date.now() / 1000);
    const path = this.normalizePath(localPath);

    const txn = this.db.transaction(() => {
      this.upsertFile(path, { ...opts, lastSyncAt: now });

      if (opts.originalDomain != null) {
        this.db.prepare(
          "UPDATE files SET original_domain = ? " +
          "WHERE path = ? AND original_domain IS NULL",
        ).run(opts.originalDomain, path);
      }

      if (opts.action) {
        this.db.prepare(
          "INSERT INTO sync_log " +
          "(timestamp, path, action, direction, old_hash, new_hash, cloud_id, detail) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          now, path, opts.action, opts.direction ?? null,
          opts.oldHash ?? null, opts.contentHash ?? null,
          opts.fileId, opts.detail ?? null,
        );
      }
    });
    txn();
  }

  cacheCloudFileInfo(
    localPath: string,
    opts: {
      fileId: FileId;
      cloudMtime: number;
      parentId?: DirId | null;
      domain?: NoteDomain | null;
      createTime?: number | null;
    },
  ): void {
    if (!localPath) throw new Error("localPath must not be empty");
    const path = this.normalizePath(localPath);
    this.db.prepare(
      "INSERT INTO files " +
      "(path, file_id, cloud_mtime, local_mtime, parent_id, domain, create_time) " +
      "VALUES (?, ?, ?, 0, ?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET " +
      "  file_id = excluded.file_id," +
      "  parent_id = COALESCE(excluded.parent_id, files.parent_id)," +
      "  domain = COALESCE(excluded.domain, files.domain)," +
      "  create_time = CASE WHEN excluded.create_time IS NOT NULL" +
      "                      AND excluded.create_time > 0" +
      "                THEN excluded.create_time ELSE files.create_time END",
    ).run(
      path,
      opts.fileId || "",
      opts.cloudMtime,
      opts.parentId ?? null,
      opts.domain ?? null,
      opts.createTime && opts.createTime > 0 ? opts.createTime : null,
    );
  }

  removeFileInfo(localPath: string): void {
    const path = this.normalizePath(localPath);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
  }

  renamePath(oldPath: string, newPath: string): boolean {
    const oldNorm = this.normalizePath(oldPath);
    const newNorm = this.normalizePath(newPath);
    try {
      const result = this.db.prepare(
        "UPDATE files SET path = ? WHERE path = ?",
      ).run(newNorm, oldNorm);
      return result.changes > 0;
    } catch (e: unknown) {
      if (String(e).includes("UNIQUE constraint")) {
        this.db.prepare("DELETE FROM files WHERE path = ?").run(oldNorm);
        return false;
      }
      throw e;
    }
  }

  getAllFiles(): Map<string, MetadataRecord> {
    const rows = this.db.prepare(
      `SELECT path, ${FILE_META_COLS} FROM files`,
    ).all() as Array<Record<string, unknown>>;
    const result = new Map<string, MetadataRecord>();
    for (const row of rows) {
      result.set(row['path'] as string, rowToMetadata(row));
    }
    return result;
  }

  // ========== Directory methods ==========

  getDirId(localPath: string): DirId | null {
    const path = this.normalizePath(localPath);
    const row = this.db.prepare(
      "SELECT dir_id FROM directories WHERE path = ?",
    ).get(path) as { dir_id: string } | undefined;
    return (row?.dir_id || null) as DirId | null;
  }

  setDirInfo(localPath: string, dirId: DirId, parentId?: DirId | null): void {
    const path = this.normalizePath(localPath);
    this.db.prepare(
      "INSERT OR REPLACE INTO directories (path, dir_id, parent_id) VALUES (?, ?, ?)",
    ).run(path, dirId || "", parentId || "");
  }

  removeDir(localPath: string): void {
    const path = this.normalizePath(localPath);
    this.db.prepare("DELETE FROM directories WHERE path = ?").run(path);
  }

  getAllDirs(): Map<string, { dirId: DirId; parentId: DirId | null }> {
    const rows = this.db.prepare(
      "SELECT path, dir_id, parent_id FROM directories",
    ).all() as Array<{ path: string; dir_id: string; parent_id: string }>;
    const result = new Map<string, { dirId: DirId; parentId: DirId | null }>();
    for (const row of rows) {
      result.set(row.path, {
        dirId: row.dir_id as DirId,
        parentId: (row.parent_id || null) as DirId | null,
      });
    }
    return result;
  }

  // ========== Lookup methods ==========

  findByFileId(fileId: FileId): string | null {
    if (!fileId) return null;
    const row = this.db.prepare(
      "SELECT path FROM files WHERE file_id = ?",
    ).get(fileId) as { path: string } | undefined;
    return row?.path ?? null;
  }

  findByDirId(dirId: DirId): string | null {
    if (!dirId) return null;
    const row = this.db.prepare(
      "SELECT path FROM directories WHERE dir_id = ?",
    ).get(dirId) as { path: string } | undefined;
    return row?.path ?? null;
  }

  // ========== Content hash ==========

  updateContentHash(localPath: string, contentHash: ContentHash): void {
    const path = this.normalizePath(localPath);
    this.db.prepare(
      "UPDATE files SET content_hash = ? WHERE path = ?",
    ).run(contentHash || "", path);
  }

  getContentHash(localPath: string): ContentHash | null {
    const path = this.normalizePath(localPath);
    const row = this.db.prepare(
      "SELECT content_hash FROM files WHERE path = ?",
    ).get(path) as { content_hash: string | null } | undefined;
    return (row?.content_hash || null) as ContentHash | null;
  }

  setCloudContentHash(localPath: string, cloudHash: ContentHash): void {
    const path = this.normalizePath(localPath);
    this.db.prepare(
      "UPDATE files SET cloud_content_hash = ? WHERE path = ?",
    ).run(cloudHash, path);
  }

  // ========== Sync state (key-value) ==========

  getState(key: string): string | null {
    const row = this.db.prepare(
      "SELECT value FROM sync_state WHERE key = ?",
    ).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db.prepare(
      "INSERT INTO sync_state (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, String(value));
  }

  getStateInt(key: string, defaultValue = 0): number {
    const val = this.getState(key);
    if (val === null) return defaultValue;
    const n = parseInt(val, 10);
    return isNaN(n) ? defaultValue : n;
  }

  // ========== Batch operations ==========

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  save(): void {
    this.saveCount++;
    if (this.saveCount % 50 === 0) {
      this.db.pragma('wal_checkpoint(PASSIVE)');
    }
  }

  // ========== Internal ==========

  private upsertFile(
    path: string,
    opts: {
      fileId: FileId;
      cloudMtime: number;
      localMtime: number;
      parentId?: DirId | null;
      domain?: NoteDomain | null;
      contentHash?: ContentHash | null;
      createTime?: number | null;
      lastSyncAt?: number;
      cloudContentHash?: ContentHash | null;
    },
  ): void {
    this.db.prepare(
      "INSERT INTO files " +
      "(path, file_id, cloud_mtime, local_mtime, parent_id, domain, " +
      " content_hash, create_time, last_sync_at, cloud_content_hash) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET " +
      "  file_id = excluded.file_id," +
      "  cloud_mtime = excluded.cloud_mtime," +
      "  local_mtime = excluded.local_mtime," +
      "  parent_id = COALESCE(excluded.parent_id, files.parent_id)," +
      "  domain = COALESCE(excluded.domain, files.domain)," +
      "  content_hash = COALESCE(excluded.content_hash, files.content_hash)," +
      "  create_time = CASE WHEN excluded.create_time IS NOT NULL" +
      "                      AND excluded.create_time > 0" +
      "                THEN excluded.create_time ELSE files.create_time END," +
      "  last_sync_at = CASE WHEN excluded.last_sync_at > 0" +
      "                 THEN excluded.last_sync_at" +
      "                 ELSE files.last_sync_at END," +
      "  cloud_content_hash = COALESCE(excluded.cloud_content_hash," +
      "                                files.cloud_content_hash)",
    ).run(
      path,
      opts.fileId || "",
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
}

function rowToMetadata(row: Record<string, unknown>): MetadataRecord {
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
  };
}
