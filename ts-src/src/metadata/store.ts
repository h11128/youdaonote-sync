import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
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
import * as storeHashCache from './store-hash-cache.js';
import {
  appendSyncLog as writeAppendSyncLog,
  recordSync as writeRecordSync,
} from './store-sync-write.js';
import type { AppendSyncLogOpts, RecordSyncOpts } from './store-sync-write.js';
import type { SyncLogEntry } from './store-sync-log.js';

const ERR_EMPTY_LOCAL_PATH = 'localPath must not be empty';

function requireLocalPath(localPath: RelPath): void {
  if (!localPath) throw new Error(ERR_EMPTY_LOCAL_PATH);
}

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
    storeHashCache.validateHashCacheVersion(this.db);
  }

  close(): void {
    this.db.close();
  }

  private normalizePath(localPath: RelPath): RelPath {
    return asRelPath(normalizeSep(localPath));
  }

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
    requireLocalPath(localPath);
    storeFiles.upsertFile(this.db, this.normalizePath(localPath), opts);
  }

  recordSync(localPath: RelPath, opts: RecordSyncOpts): void {
    requireLocalPath(localPath);
    writeRecordSync(this.db, this.normalizePath(localPath), opts);
  }

  /** Append sync_log without upserting `files` (dirs live in `dirs`). */
  appendSyncLog(localPath: RelPath, opts: AppendSyncLogOpts): void {
    requireLocalPath(localPath);
    writeAppendSyncLog(this.db, this.normalizePath(localPath), opts);
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
    requireLocalPath(localPath);
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

  updateContentHash(localPath: RelPath, contentHash: ContentHash): void {
    storeFiles.updateContentHash(this.db, this.normalizePath(localPath), contentHash);
  }

  getContentHash(localPath: RelPath): ContentHash | null {
    return storeFiles.getContentHash(this.db, this.normalizePath(localPath));
  }

  setCloudContentHash(localPath: RelPath, cloudHash: ContentHash): void {
    storeFiles.setCloudContentHash(this.db, this.normalizePath(localPath), cloudHash);
  }

  getCachedHash(path: RelPath, mtime: EpochSeconds, size: number): ContentHash | null {
    return storeHashCache.getCachedHash(this.db, this.normalizePath(path), mtime, size);
  }

  setCachedHash(path: RelPath, mtime: EpochSeconds, size: number, hash: ContentHash): void {
    storeHashCache.setCachedHash(this.db, { path: this.normalizePath(path), mtime, size, hash });
  }

  getCachedHashesBulk(
    entries: readonly { relPath: RelPath; mtime: EpochSeconds; size: number }[],
  ): Map<RelPath, ContentHash> {
    return storeHashCache.getCachedHashesBulk(this.db, entries);
  }

  setCachedHashesBulk(
    entries: readonly { path: string; mtime: EpochSeconds; size: number; hash: ContentHash }[],
  ): void {
    this.batch(() => {
      storeHashCache.setCachedHashesBulk(this.db, entries);
    });
  }

  getState(key: string): string | null {
    return storeState.getState(this.db, key);
  }

  setState(key: string, value: string): void {
    storeState.setState(this.db, key, value);
  }

  getStateInt(key: string, defaultValue = 0): number {
    return storeState.getStateInt(this.db, key, defaultValue);
  }

  getSyncLog(opts?: { limit?: number; path?: RelPath }): SyncLogEntry[] {
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

  batch<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  save(): void {
    this.saveCount++;
    if (this.saveCount % 50 === 0) {
      this.db.pragma('wal_checkpoint(PASSIVE)');
    }
  }

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
