import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
      setState: (key: string, value: string) => {
        this.setState(key, value);
      },
    };
    runAllMigrations(this.db, accessor, sanitizeFilename);
  }

  close(): void {
    this.db.close();
  }

  // ========== Path normalization ==========

  private normalizePath(localPath: RelPath): RelPath {
    return asRelPath(normalizeSep(localPath));
  }

  // ========== File methods (delegate to store-files) ==========

  getFileId(localPath: RelPath): FileId | null {
    return storeFiles.getFileId(this.db, this.normalizePath(localPath));
  }

  getFileInfo(localPath: RelPath): MetadataRecord | null {
    return storeFiles.getFileInfo(this.db, this.normalizePath(localPath));
  }

  markSynced(localPath: RelPath, ts?: EpochSeconds): void {
    storeFiles.markSynced(this.db, this.normalizePath(localPath), ts);
  }

  setFileInfo(
    localPath: RelPath,
    opts: {
      fileId: FileId;
      cloudMtime: EpochSeconds;
      localMtime: EpochSeconds;
      parentId?: DirId | null;
      domain?: NoteDomain | null;
      contentHash?: ContentHash | null;
      createTime?: EpochSeconds | null;
      lastSyncAt?: EpochSeconds;
      cloudContentHash?: ContentHash | null;
    },
  ): void {
    if (!localPath) throw new Error('localPath must not be empty');
    storeFiles.upsertFile(this.db, this.normalizePath(localPath), opts);
  }

  recordSync(
    localPath: RelPath,
    opts: {
      fileId: FileId;
      cloudMtime: EpochSeconds;
      localMtime: EpochSeconds;
      parentId?: DirId | null;
      domain?: NoteDomain | null;
      contentHash?: ContentHash | null;
      cloudContentHash?: ContentHash | null;
      originalDomain?: NoteDomain | null;
      createTime?: EpochSeconds | null;
      action?: string;
      direction?: string;
      oldHash?: ContentHash | null;
      detail?: string;
    },
  ): void {
    if (!localPath) throw new Error('localPath must not be empty');
    const now = asEpochSeconds(Math.floor(Date.now() / 1000));
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
    localPath: RelPath,
    opts: {
      fileId: FileId;
      cloudMtime: EpochSeconds;
      parentId?: DirId | null;
      domain?: NoteDomain | null;
      createTime?: EpochSeconds | null;
    },
  ): void {
    if (!localPath) throw new Error('localPath must not be empty');
    storeFiles.cacheCloudFileInfo(this.db, this.normalizePath(localPath), opts);
  }

  removeFileInfo(localPath: RelPath): void {
    storeFiles.removeFileInfo(this.db, this.normalizePath(localPath));
  }

  renamePath(oldPath: RelPath, newPath: RelPath): boolean {
    return storeFiles.renamePath(this.db, this.normalizePath(oldPath), this.normalizePath(newPath));
  }

  getAllFiles(): Map<RelPath, MetadataRecord> {
    return storeFiles.getAllFiles(this.db);
  }

  getCloudFileSummaries(): Map<RelPath, storeFiles.CloudFileSummary> {
    return storeFiles.getCloudFileSummaries(this.db);
  }

  // ========== Directory methods (delegate to store-dirs) ==========

  getDirId(localPath: RelPath): DirId | null {
    return storeDirs.getDirId(this.db, this.normalizePath(localPath));
  }

  setDirInfo(localPath: RelPath, dirId: DirId, parentId?: DirId | null): void {
    storeDirs.setDirInfo(this.db, this.normalizePath(localPath), dirId, parentId);
  }

  removeDir(localPath: RelPath): void {
    storeDirs.removeDir(this.db, this.normalizePath(localPath));
  }

  getAllDirs(): Map<RelPath, { dirId: DirId; parentId: DirId | null }> {
    return storeDirs.getAllDirs(this.db);
  }

  // ========== Lookup methods ==========

  findByFileId(fileId: FileId): RelPath | null {
    return storeFiles.findByFileId(this.db, fileId);
  }

  findCloudFileByHash(contentHash: ContentHash, excludePath?: RelPath): RelPath | null {
    return storeFiles.findCloudFileByHash(
      this.db,
      contentHash,
      excludePath ? this.normalizePath(excludePath) : undefined,
    );
  }

  findByDirId(dirId: DirId): RelPath | null {
    return storeDirs.findByDirId(this.db, dirId);
  }

  // ========== Content hash ==========

  updateContentHash(localPath: RelPath, contentHash: ContentHash): void {
    storeFiles.updateContentHash(this.db, this.normalizePath(localPath), contentHash);
  }

  getContentHash(localPath: RelPath): ContentHash | null {
    return storeFiles.getContentHash(this.db, this.normalizePath(localPath));
  }

  setCloudContentHash(localPath: RelPath, cloudHash: ContentHash): void {
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

  getSyncLog(opts?: { limit?: number; path?: RelPath }): {
    id: number;
    timestamp: EpochSeconds;
    path: RelPath;
    action: string;
    direction: string | null;
    oldHash: string | null;
    newHash: string | null;
    cloudId: string | null;
    detail: string | null;
  }[] {
    return storeState.getSyncLog(this.db, opts, (p) => this.normalizePath(p));
  }

  saveBaseContent(localPath: RelPath, content: Buffer, hash: string): void {
    storeState.saveBaseContent(this.db, this.normalizePath(localPath), content, hash);
  }

  getBaseContent(localPath: RelPath): { content: Buffer; hash: string } | null {
    return storeState.getBaseContent(this.db, this.normalizePath(localPath));
  }

  removeBaseContent(localPath: RelPath): void {
    storeState.removeBaseContent(this.db, this.normalizePath(localPath));
  }

  getFileRefs(sourcePath: RelPath): string[] {
    return storeState.getFileRefs(this.db, this.normalizePath(sourcePath));
  }

  setFileRefs(sourcePath: RelPath, refs: string[]): void {
    storeState.setFileRefs(this.db, this.normalizePath(sourcePath), refs);
  }

  getAllFileRefs(): Map<RelPath, string[]> {
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

  getStaleFilePaths(cutoffTs: EpochSeconds): RelPath[] {
    return storeFiles.getStaleFilePaths(this.db, cutoffTs);
  }

  getAllDirPaths(): RelPath[] {
    return storeDirs.getAllDirPaths(this.db);
  }

  deleteSyncLogBefore(cutoffTs: EpochSeconds): number {
    return storeState.deleteSyncLogBefore(this.db, cutoffTs);
  }

  getAllBaseContentPaths(): RelPath[] {
    return storeState.getAllBaseContentPaths(this.db);
  }

  updateLocalMtime(localPath: RelPath, mtime: EpochSeconds): void {
    storeFiles.updateLocalMtime(this.db, this.normalizePath(localPath), mtime);
  }

  getStaleCloudPaths(activePaths: ReadonlySet<RelPath>): RelPath[] {
    return storeFiles.getStaleCloudPaths(this.db, activePaths);
  }

  clearCloudId(localPath: RelPath): void {
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
