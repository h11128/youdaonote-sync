import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContentHash, DirId, FileId, NoteDomain } from '../types/common.js';
import type { MetadataRecord } from '../types/metadata.js';
import { runAllMigrations } from './migrations.js';
import { sanitizeFilename, normalizeSep } from '../util/path.js';
import * as storeDirs from './store-dirs.js';
import * as storeState from './store-state.js';
import * as storeFiles from './store-files.js';

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

  // ========== File methods (delegate to store-files) ==========

  getFileId(localPath: string): FileId | null {
    return storeFiles.getFileId(this.db, this.normalizePath(localPath));
  }

  getFileInfo(localPath: string): MetadataRecord | null {
    return storeFiles.getFileInfo(this.db, this.normalizePath(localPath));
  }

  markSynced(localPath: string, ts?: number): void {
    storeFiles.markSynced(this.db, this.normalizePath(localPath), ts);
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
    storeFiles.upsertFile(this.db, this.normalizePath(localPath), opts);
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
      storeFiles.upsertFile(this.db, path, { ...opts, lastSyncAt: now });
      if (opts.originalDomain != null) {
        storeFiles.updateOriginalDomain(this.db, path, opts.originalDomain);
      }
      if (opts.action) {
        storeState.insertSyncLog(this.db, {
          timestamp: now,
          path,
          action: opts.action,
          direction: opts.direction ?? null,
          oldHash: opts.oldHash ?? null,
          newHash: opts.contentHash ?? null,
          cloudId: opts.fileId,
          detail: opts.detail ?? null,
        });
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
    storeFiles.cacheCloudFileInfo(this.db, this.normalizePath(localPath), opts);
  }

  removeFileInfo(localPath: string): void {
    storeFiles.removeFileInfo(this.db, this.normalizePath(localPath));
  }

  renamePath(oldPath: string, newPath: string): boolean {
    return storeFiles.renamePath(
      this.db,
      this.normalizePath(oldPath),
      this.normalizePath(newPath),
    );
  }

  getAllFiles(): Map<string, MetadataRecord> {
    return storeFiles.getAllFiles(this.db);
  }

  getCloudFileSummaries(): Map<string, storeFiles.CloudFileSummary> {
    return storeFiles.getCloudFileSummaries(this.db);
  }

  // ========== Directory methods (delegate to store-dirs) ==========

  getDirId(localPath: string): DirId | null {
    return storeDirs.getDirId(this.db, this.normalizePath(localPath));
  }

  setDirInfo(localPath: string, dirId: DirId, parentId?: DirId | null): void {
    storeDirs.setDirInfo(this.db, this.normalizePath(localPath), dirId, parentId);
  }

  removeDir(localPath: string): void {
    storeDirs.removeDir(this.db, this.normalizePath(localPath));
  }

  getAllDirs(): Map<string, { dirId: DirId; parentId: DirId | null }> {
    return storeDirs.getAllDirs(this.db);
  }

  // ========== Lookup methods ==========

  findByFileId(fileId: FileId): string | null {
    return storeFiles.findByFileId(this.db, fileId);
  }

  findCloudFileByHash(contentHash: ContentHash, excludePath?: string): string | null {
    return storeFiles.findCloudFileByHash(this.db, contentHash, excludePath ? this.normalizePath(excludePath) : undefined);
  }

  findByDirId(dirId: DirId): string | null {
    return storeDirs.findByDirId(this.db, dirId);
  }

  // ========== Content hash ==========

  updateContentHash(localPath: string, contentHash: ContentHash): void {
    storeFiles.updateContentHash(this.db, this.normalizePath(localPath), contentHash);
  }

  getContentHash(localPath: string): ContentHash | null {
    return storeFiles.getContentHash(this.db, this.normalizePath(localPath));
  }

  setCloudContentHash(localPath: string, cloudHash: ContentHash): void {
    storeFiles.setCloudContentHash(this.db, this.normalizePath(localPath), cloudHash);
  }

  // ========== Sync state & log & file_base (delegate to store-state) ==========

  getState(key: string): string | null {
    return storeState.getState(this.db, key);
  }

  setState(key: string, value: string): void {
    storeState.setState(this.db, key, value);
  }

  getStateInt(key: string, defaultValue = 0): number {
    return storeState.getStateInt(this.db, key, defaultValue);
  }

  getSyncLog(opts?: { limit?: number; path?: string }): Array<{
    id: number; timestamp: number; path: string; action: string;
    direction: string | null; oldHash: string | null; newHash: string | null;
    cloudId: string | null; detail: string | null;
  }> {
    return storeState.getSyncLog(this.db, opts, (p) => this.normalizePath(p));
  }

  saveBaseContent(localPath: string, content: Buffer, hash: string): void {
    storeState.saveBaseContent(this.db, this.normalizePath(localPath), content, hash);
  }

  getBaseContent(localPath: string): { content: Buffer; hash: string } | null {
    return storeState.getBaseContent(this.db, this.normalizePath(localPath));
  }

  removeBaseContent(localPath: string): void {
    storeState.removeBaseContent(this.db, this.normalizePath(localPath));
  }

  getFileRefs(sourcePath: string): string[] {
    return storeState.getFileRefs(this.db, this.normalizePath(sourcePath));
  }

  setFileRefs(sourcePath: string, refs: string[]): void {
    storeState.setFileRefs(this.db, this.normalizePath(sourcePath), refs);
  }

  getAllFileRefs(): Map<string, string[]> {
    return storeState.getAllFileRefs(this.db);
  }

  // ========== Batch operations ==========

  /**
   * Run multiple operations in a single SQLite transaction.
   * All writes inside `fn` are committed atomically on success, or rolled back on error.
   */
  batch<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  save(): void {
    this.saveCount++;
    if (this.saveCount % 50 === 0) {
      this.db.pragma('wal_checkpoint(PASSIVE)');
    }
  }

  // ========== Health operations (gc / heal internals) ==========

  getStaleFilePaths(cutoffTs: number): string[] {
    return storeFiles.getStaleFilePaths(this.db, cutoffTs);
  }

  getAllDirPaths(): string[] {
    return storeDirs.getAllDirPaths(this.db);
  }

  deleteSyncLogBefore(cutoffTs: number): number {
    return storeState.deleteSyncLogBefore(this.db, cutoffTs);
  }

  getAllBaseContentPaths(): string[] {
    return storeState.getAllBaseContentPaths(this.db);
  }

  updateLocalMtime(localPath: string, mtime: number): void {
    storeFiles.updateLocalMtime(this.db, this.normalizePath(localPath), mtime);
  }

  getStaleCloudPaths(activePaths: ReadonlySet<string>): string[] {
    return storeFiles.getStaleCloudPaths(this.db, activePaths);
  }

  clearCloudId(localPath: string): void {
    storeFiles.clearCloudId(this.db, this.normalizePath(localPath));
  }

  /**
   * @internal Exposed for test fixtures only. Production code must use
   * typed methods above — never raw SQL through this accessor.
   */
  get connection(): Database.Database {
    return this.db;
  }
}
