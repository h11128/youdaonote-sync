import { basename, extname } from 'node:path';
import type { DirId, ContentHash, FileId, NoteDomain } from './types/common.js';
import type { CloudFile, LocalFile } from './types/scan.js';
import type { FileState } from './types/state.js';
import { stateToAction } from './types/state.js';
import type { SyncAction } from './types/state.js';
import { YoudaoNoteApi } from './api/client.js';
import { MetadataStore } from './metadata/store.js';
import { heal } from './metadata/health.js';
import { scanCloud } from './scan/cloud.js';
import { scanLocal } from './scan/local.js';
import { mapCloudName } from './scan/name.js';
import { classifyAll } from './classify/classify.js';
import { detectMoves } from './classify/moves.js';
import { calibrateMetadata } from './classify/calibrate.js';
import { refineCloudModified } from './classify/refine.js';
import { executeAll, emptyStats } from './execute/executor.js';
import type { SyncStats, ExecuteContext } from './execute/executor.js';
import { computeContentHashFromBytes, computeContentHashFromFile, initXxhash } from './hash.js';
import { SyncLock } from './lock.js';
import { autoDedup, discardOrphanDuplicates } from './dedup.js';
import { gitAutoCommit } from './git.js';
import { retryWithBackoff } from './api/retry.js';
import { seedMetadataFromDesktop } from './desktop-data.js';

const HASHABLE_EXTS = new Set(['.md', '.txt', '.html', '.htm', '.xml', '.json']);
const STATE_CLOUD_VERSION = 'last_cloud_version';
const STATE_SCAN_TIME = 'last_scan_time';

export type SyncDirection = 'both' | 'pull' | 'push';

export interface SyncEngineConfig {
  cookiesPath: string;
  metadataPath: string;
  localDir: string;
  syncInclude?: string[] | undefined;
  syncExclude?: string[] | undefined;
  dryRun?: boolean | undefined;
  direction?: SyncDirection | undefined;
  autoGit?: boolean | undefined;
  autoDedup?: boolean | undefined;
  hashFn?: ((data: Uint8Array, path: string) => ContentHash | null) | undefined;
  /** Optional: inject for testing; otherwise created from cookiesPath/metadataPath. */
  api?: YoudaoNoteApi;
  /** Optional: inject for testing; otherwise created from metadataPath. */
  meta?: MetadataStore;
}

export interface SyncResult {
  stats: SyncStats;
  classified: Map<string, FileState>;
}

/**
 * The sync engine: Init → Heal → Scan → Calibrate → Moves → Orphan Discard
 *   → Warmup → Classify → Refine → Filter → Execute → Cleanup → Dedup → Git.
 */
export class SyncEngine {
  private api: YoudaoNoteApi;
  private meta: MetadataStore;
  private config: SyncEngineConfig;

  constructor(config: SyncEngineConfig) {
    this.config = config;
    this.api = config.api ?? new YoudaoNoteApi(config.cookiesPath);
    this.meta = config.meta ?? new MetadataStore(config.metadataPath);
  }

  async sync(): Promise<SyncResult> {
    await initXxhash();

    // 0. Login
    const loginErr = this.api.loginByCookies();
    if (loginErr) throw new Error(`Login failed: ${loginErr}`);

    const lock = new SyncLock(this.config.localDir);
    if (!this.config.dryRun && !lock.acquire()) {
      throw new Error('Cannot acquire sync lock — another sync process is running');
    }

    try {
      return await this.syncInner();
    } finally {
      if (!this.config.dryRun) lock.release();
    }
  }

  private async syncInner(): Promise<SyncResult> {
    const { localDir, dryRun } = this.config;

    // 0b. Self-heal metadata before sync
    if (!dryRun) {
      heal(this.meta, localDir, true);
    }

    // 1. Scan
    const rootDirId = await this.api.getRootId();
    const scanOpts: { include?: string[]; exclude?: string[] } = {};
    if (this.config.syncInclude) scanOpts.include = this.config.syncInclude;
    if (this.config.syncExclude) scanOpts.exclude = this.config.syncExclude;

    // Try cached cloud scan first, fall back to full scan
    let cloudSnap: Map<string, CloudFile>;
    const cachedCloud = await this.tryCachedCloudScan();
    if (cachedCloud) {
      cloudSnap = cachedCloud;
    } else {
      cloudSnap = await scanCloud(this.api, rootDirId);
      this.saveScanVersion(cloudSnap, await this.fetchCurrentVersion());
    }

    const localSnap = scanLocal(localDir, '', scanOpts);

    // 1b. Calibrate metadata for files present on both sides
    const localHashes = new Map<string, ContentHash | null>();
    calibrateMetadata(this.meta, cloudSnap, localSnap, localHashes);

    // 1c. Compute local hashes (reuses any computed during calibration)
    for (const [relPath, local] of localSnap) {
      if (!local.isDir && !localHashes.has(relPath)) {
        const hash = computeContentHashFromFile(local.path);
        localHashes.set(relPath, hash);
      }
    }

    // 1d. Warmup: pre-compute hashes for "both side" files in parallel
    await this.warmupHashCache(cloudSnap, localSnap, localHashes);

    const metaSnap = this.meta.getAllFiles();

    // 2. Classify
    const classified = classifyAll(cloudSnap, localSnap, metaSnap, localHashes);

    // 2b. Detect moves
    const classifiedWithHash = new Map<string, { state: FileState; hash: ContentHash | null }>();
    for (const [path, state] of classified) {
      classifiedWithHash.set(path, { state, hash: localHashes.get(path) ?? null });
    }
    const moves = detectMoves(classifiedWithHash, this.meta, cloudSnap);
    for (const [path, movedState] of moves) {
      classified.set(path, movedState);
    }

    // 2c. Discard orphan local duplicates before refine/execute
    const orphans = discardOrphanDuplicates(cloudSnap, localSnap, localHashes);
    for (const orphanPath of orphans) {
      classified.set(orphanPath, { kind: 'gone' });
    }

    // 2d. Refine conflicts — download cloud content hash to distinguish
    //     mtime-only changes, converged edits, and true conflicts
    await this.refineConflicts(classified, cloudSnap, localHashes);

    // 2e. Filter by direction
    const direction = this.config.direction ?? 'both';
    if (direction !== 'both') {
      filterByDirection(classified, direction);
    }

    // 3. Execute
    if (dryRun) {
      return { stats: dryRunStats(classified), classified };
    }

    const hashFn = this.config.hashFn ?? computeContentHashFromBytes;
    const ctx: ExecuteContext = {
      api: this.api,
      meta: this.meta,
      rootDirId,
      localDir,
      hashFn,
    };

    const stats = await executeAll(classified, cloudSnap, ctx);

    // 4. Post-sync: cleanup stale metadata
    this.cleanupStalePaths(cloudSnap);

    // 5. Post-sync: auto-dedup
    if (this.config.autoDedup !== false) {
      await autoDedup(localDir, this.meta, { api: this.api });
    }

    this.meta.save();

    // 6. Post-sync: git auto-commit
    if (this.config.autoGit !== false) {
      gitAutoCommit(localDir);
    }

    return { stats, classified };
  }

  /**
   * Pre-compute content hashes for files on both sides (warm the cache).
   * Only computes for hashable extensions that haven't been computed yet.
   */
  private async warmupHashCache(
    cloudSnap: ReadonlyMap<string, CloudFile>,
    localSnap: ReadonlyMap<string, LocalFile>,
    localHashes: Map<string, ContentHash | null>,
  ): Promise<void> {
    const toCompute: Array<{ relPath: string; absPath: string }> = [];
    for (const [relPath, local] of localSnap) {
      if (local.isDir || localHashes.has(relPath)) continue;
      if (!cloudSnap.has(relPath)) continue;
      const ext = extname(relPath).toLowerCase();
      if (!HASHABLE_EXTS.has(ext)) continue;
      toCompute.push({ relPath, absPath: local.path });
    }

    // Compute in small batches to avoid blocking
    const BATCH = 50;
    for (let i = 0; i < toCompute.length; i += BATCH) {
      const batch = toCompute.slice(i, i + BATCH);
      for (const { relPath, absPath } of batch) {
        const hash = computeContentHashFromFile(absPath);
        localHashes.set(relPath, hash);
      }
    }
  }

  /**
   * Second-pass classification: for cloudModifiedContent and conflict entries,
   * download cloud content, compute cloud hash, and use refineCloudModified
   * to potentially downgrade to skip/upload/download.
   */
  private async refineConflicts(
    classified: Map<string, FileState>,
    cloudSnap: ReadonlyMap<string, CloudFile>,
    localHashes: ReadonlyMap<string, ContentHash | null>,
  ): Promise<void> {
    const candidates: Array<{ relPath: string; cloudFile: CloudFile }> = [];
    for (const [relPath, state] of classified) {
      if (state.kind !== 'cloudModifiedContent' && state.kind !== 'conflict') continue;
      const ext = extname(relPath).toLowerCase();
      if (!HASHABLE_EXTS.has(ext)) continue;
      const cf = cloudSnap.get(relPath);
      if (!cf) continue;
      candidates.push({ relPath, cloudFile: cf });
    }

    if (candidates.length === 0) return;

    const hashFn = this.config.hashFn ?? computeContentHashFromBytes;

    for (const { relPath, cloudFile } of candidates) {
      try {
        const rawData = await retryWithBackoff(() => this.api.getFileById(cloudFile.id as FileId));
        const data = new Uint8Array(rawData);
        const cloudHash = hashFn(data, relPath);
        if (!cloudHash) continue;

        const localHash = localHashes.get(relPath);
        if (!localHash) continue;

        const metaRecord = this.meta.getFileInfo(relPath);
        const refined = refineCloudModified(localHash, cloudHash, metaRecord);

        if (refined.kind !== classified.get(relPath)!.kind) {
          classified.set(relPath, refined);
        }

        this.meta.setCloudContentHash(relPath, cloudHash);
      } catch {
        // If cloud fetch fails, keep original classification
      }
    }
  }

  /**
   * Clean up metadata for files that no longer exist in cloud.
   * Clears the file_id so they won't be treated as cloud-linked.
   */
  private cleanupStalePaths(cloudSnap: ReadonlyMap<string, CloudFile>): void {
    const activeCloudPaths = new Set<string>();
    for (const [path, cf] of cloudSnap) {
      if (!cf.isDir) activeCloudPaths.add(path);
    }

    const stalePaths = this.meta.getStaleCloudPaths(activeCloudPaths);
    if (stalePaths.length === 0) return;

    this.meta.batch(() => {
      for (const path of stalePaths) {
        this.meta.clearCloudId(path);
      }
    });
  }

  // ========== Cached Cloud Scan ==========

  /**
   * Rebuild cloud_files from metadata (compatible with scanner format).
   * Only loads file records with file_id. Directories are excluded to avoid
   * phantom downloads from stale directory records.
   */
  private loadCloudFilesFromCache(): Map<string, CloudFile> | null {
    const summaries = this.meta.getCloudFileSummaries();
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
   * Stale path cleanup happens separately in cleanupStalePaths (after move detection).
   */
  private saveScanVersion(cloudSnap: Map<string, CloudFile>, maxVersion: number): void {
    this.meta.batch(() => {
      for (const [rel, info] of cloudSnap) {
        if (info.isDir) {
          this.meta.setDirInfo(rel, info.id as unknown as DirId, info.parentId as DirId);
        } else {
          this.meta.cacheCloudFileInfo(rel, {
            fileId: info.id,
            cloudMtime: info.mtime,
            parentId: info.parentId,
            domain: info.domain ?? 0,
            createTime: info.ctime ?? 0,
          });
        }
      }
      this.meta.setState(STATE_CLOUD_VERSION, String(maxVersion));
      this.meta.setState(STATE_SCAN_TIME, String(Math.floor(Date.now() / 1000)));
    });
    this.meta.save();
  }

  /** Fetch cloud max version via listRecent. */
  private async fetchCurrentVersion(): Promise<number> {
    try {
      const recent = await this.api.listRecent(1);
      if (recent.length > 0) {
        const fe = recent[0]!['fileEntry'] as Record<string, unknown> | undefined;
        return (fe?.['version'] as number) || 0;
      }
    } catch { /* ignore */ }
    return 0;
  }

  /** Try seed from desktop client (cold start). Skipped if API is injected (test mode). */
  private trySeedFromDesktop(): boolean {
    if (this.config.api) return false;
    if (this.meta.getAllFiles().size > 0) return false;
    try {
      return seedMetadataFromDesktop(this.meta) > 0;
    } catch { return false; }
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
  private async tryCachedCloudScan(): Promise<Map<string, CloudFile> | null> {
    let cachedVersion = this.meta.getStateInt(STATE_CLOUD_VERSION);
    if (cachedVersion <= 0) {
      if (this.trySeedFromDesktop()) {
        cachedVersion = this.meta.getStateInt(STATE_CLOUD_VERSION);
      }
      if (cachedVersion <= 0) return null;
    }

    let recent: Array<Record<string, unknown>>;
    try {
      recent = await this.api.listRecent(30);
    } catch {
      const cached = this.loadCloudFilesFromCache();
      return cached ?? null;
    }

    if (recent.length === 0) {
      return this.loadCloudFilesFromCache();
    }

    const cloudMaxVersion = Math.max(
      ...recent.map((e) => {
        const fe = e['fileEntry'] as Record<string, unknown> | undefined;
        return (fe?.['version'] as number) || 0;
      }),
    );

    if (cachedVersion >= cloudMaxVersion) {
      return this.loadCloudFilesFromCache();
    }

    const changed = recent.filter((e) => {
      const fe = e['fileEntry'] as Record<string, unknown> | undefined;
      return ((fe?.['version'] as number) || 0) > cachedVersion;
    });
    const allCovered = changed.length < recent.length;

    if (!allCovered) return null;

    const cached = this.loadCloudFilesFromCache();
    if (!cached) return null;

    this.applyIncrementalChanges(cached, changed);
    this.meta.setState(STATE_CLOUD_VERSION, String(cloudMaxVersion));
    this.meta.setState(STATE_SCAN_TIME, String(Math.floor(Date.now() / 1000)));
    this.meta.save();

    return cached;
  }

  /**
   * Apply listRecent changes to the cached cloud_files and metadata.
   */
  private applyIncrementalChanges(
    cloudFiles: Map<string, CloudFile>,
    changedEntries: Array<Record<string, unknown>>,
  ): void {
    this.meta.batch(() => {
      for (const entry of changedEntries) {
        const fe = entry['fileEntry'] as Record<string, unknown> | undefined;
        if (!fe) continue;
        const fid = (fe['id'] as string) || '';
        const name = (fe['name'] as string) || '';
        if (!fid || !name) continue;

        const isDir = Boolean(fe['dir']);
        const parentId = (fe['parentId'] as string) || '';

        const existingPath = isDir
          ? this.meta.findByDirId(fid as DirId)
          : this.meta.findByFileId(fid as FileId);

        if (isDir) {
          if (existingPath) {
            cloudFiles.set(existingPath, {
              id: fid as FileId, parentId: parentId as DirId, name,
              isDir: true, mtime: 0, ctime: 0, domain: 0 as NoteDomain,
            });
            this.meta.setDirInfo(existingPath, fid as DirId, parentId as DirId);
          }
        } else {
          const localName = mapCloudName(name);
          const mtime = (fe['modifyTimeForSort'] as number) || 0;
          const ctime = (fe['createTimeForSort'] as number) || 0;
          const domain = ((fe['domain'] as number) || 0) as NoteDomain;
          const info: CloudFile = {
            id: fid as FileId, parentId: parentId as DirId, name,
            isDir: false, mtime, ctime, domain,
          };
          if (existingPath) {
            cloudFiles.set(existingPath, info);
            this.meta.cacheCloudFileInfo(existingPath, {
              fileId: fid as FileId,
              cloudMtime: mtime,
              parentId: parentId as DirId,
              domain,
              createTime: ctime,
            });
          }
          // New files not in cache will be discovered by full scan next time
        }
      }
    });
  }

  close(): void {
    this.meta.close();
  }
}

/**
 * Filter classified entries by sync direction.
 * 'pull' keeps only downloads/conflicts; 'push' keeps only uploads.
 * Non-matching entries are set to 'gone' (skipped).
 */
function filterByDirection(classified: Map<string, FileState>, direction: 'pull' | 'push'): void {
  const allowedActions: Set<SyncAction> = direction === 'pull'
    ? new Set(['download', 'conflict'])
    : new Set(['upload']);

  for (const [path, state] of classified) {
    const action = stateToAction(state);
    if (action === 'skip' || action === 'move') continue;
    if (!allowedActions.has(action)) {
      classified.set(path, { kind: 'gone' });
    }
  }
}

function dryRunStats(classified: Map<string, FileState>): SyncStats {
  const stats = emptyStats();
  for (const state of classified.values()) {
    const action = stateToAction(state);
    switch (action) {
      case 'skip': stats.skipped++; break;
      case 'download': stats.downloaded++; break;
      case 'upload': stats.uploaded++; break;
      case 'conflict': stats.conflicts++; break;
      case 'move': stats.moved++; break;
    }
  }
  return Object.freeze(stats) as Readonly<SyncStats>;
}
