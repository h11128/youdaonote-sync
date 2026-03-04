import type { ContentHash, DirId, FileId, SyncDirection } from './types/common.js';
import type { CloudFile, LocalFile } from './types/scan.js';
import type { FileState } from './types/state.js';
import { YoudaoNoteApi } from './api/client.js';
import { MetadataStore } from './metadata/store.js';
import { heal } from './metadata/health.js';
import { scanCloud } from './scan/cloud.js';
import { scanLocal } from './scan/local.js';
import { classifyAll } from './classify/classify.js';
import { detectMoves } from './classify/moves.js';
import { calibrateMetadata } from './classify/calibrate.js';
import { refineCloudModified } from './classify/refine.js';
import { executeAll } from './execute/executor.js';
import type { SyncStats, ExecuteContext } from './execute/executor.js';
import { fallbackDeleteOldFiles } from './execute/move-handler.js';
import {
  diagnoseDryrun,
  dryRunStats,
  filterCloudSnap,
  filterByDirection,
  collectConflictCandidates,
  buildDedupInputs,
  warmupHashCache,
  applyRefinementIfChanged,
  cleanupStalePaths,
} from './engine-helpers.js';
import { computeContentHashFromBytes, computeContentHashFromFile, initXxhash } from './hash.js';
import { SyncLock } from './lock.js';
import { autoDedup, discardOrphanDuplicates } from './dedup/index.js';
import { gitAutoCommit } from './git.js';
import { retryWithBackoff } from './api/retry.js';
import { tryCachedCloudScan, saveScanVersion, fetchCurrentVersion } from './scan/cloud-cache.js';

export type { SyncDirection } from './types/common.js';

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
    if (!dryRun) heal(this.meta, localDir, true);

    const { cloudSnap, localSnap, localHashes, rootDirId, didFullScan } =
      await this.obtainSnapshots(localDir);
    const classified = await this.classifyAndRefine(cloudSnap, localSnap, localHashes);
    const direction = this.config.direction ?? 'both';
    if (direction !== 'both') filterByDirection(classified, direction);

    if (dryRun) {
      diagnoseDryrun(classified, this.meta);
      return { stats: dryRunStats(classified), classified };
    }

    const stats = await this.executeSync({
      classified,
      cloudSnap,
      localSnap,
      localHashes,
      rootDirId,
      direction,
    });
    await this.postSyncCleanup({
      cloudSnap,
      localSnap,
      localHashes,
      stats,
      didFullScan,
    });
    return { stats, classified };
  }

  private async obtainSnapshots(localDir: string): Promise<{
    cloudSnap: Map<string, CloudFile>;
    localSnap: Map<string, LocalFile>;
    localHashes: Map<string, ContentHash | null>;
    rootDirId: DirId;
    didFullScan: boolean;
  }> {
    const rootDirId = await this.api.getRootId();
    const scanOpts: { include?: string[]; exclude?: string[] } = {};
    if (this.config.syncInclude) scanOpts.include = this.config.syncInclude;
    if (this.config.syncExclude) scanOpts.exclude = this.config.syncExclude;

    const cacheDeps = {
      api: this.api,
      meta: this.meta,
      skipDesktopSeed: !!this.config.api,
    };
    const cachedCloud = await tryCachedCloudScan(cacheDeps);
    let cloudSnap: Map<string, CloudFile>;
    let didFullScan = false;
    if (cachedCloud) {
      cloudSnap = cachedCloud;
    } else {
      cloudSnap = await scanCloud(this.api, rootDirId);
      saveScanVersion(this.meta, cloudSnap, await fetchCurrentVersion(this.api));
      didFullScan = true;
    }

    if (scanOpts.include?.length || scanOpts.exclude?.length) {
      filterCloudSnap(cloudSnap, scanOpts);
    }
    for (const [path] of [...cloudSnap]) {
      const name = path.split('/').pop() ?? '';
      if (name.includes('.conflict.')) cloudSnap.delete(path);
    }

    const localSnap = scanLocal(localDir, '', scanOpts);
    const localHashes = new Map<string, ContentHash | null>();
    calibrateMetadata(this.meta, cloudSnap, localSnap, localHashes);
    for (const [relPath, local] of localSnap) {
      if (!local.isDir && !localHashes.has(relPath)) {
        localHashes.set(relPath, computeContentHashFromFile(local.path));
      }
    }
    warmupHashCache(cloudSnap, localSnap, localHashes);
    return { cloudSnap, localSnap, localHashes, rootDirId, didFullScan };
  }

  private async classifyAndRefine(
    cloudSnap: Map<string, CloudFile>,
    localSnap: Map<string, LocalFile>,
    localHashes: Map<string, ContentHash | null>,
  ): Promise<Map<string, FileState>> {
    const metaSnap = this.meta.getAllFiles();
    const classified = classifyAll(cloudSnap, localSnap, metaSnap, localHashes);
    const classifiedWithHash = new Map<string, { state: FileState; hash: ContentHash | null }>();
    for (const [path, state] of classified) {
      classifiedWithHash.set(path, { state, hash: localHashes.get(path) ?? null });
    }
    for (const [path, movedState] of detectMoves(classifiedWithHash, this.meta, cloudSnap)) {
      classified.set(path, movedState);
    }
    for (const orphanPath of discardOrphanDuplicates(cloudSnap, localSnap, localHashes)) {
      classified.set(orphanPath, { kind: 'gone' });
    }
    await this.refineConflicts(classified, cloudSnap, localHashes);
    return classified;
  }

  private async executeSync(ctx: {
    classified: Map<string, FileState>;
    cloudSnap: Map<string, CloudFile>;
    localSnap: Map<string, LocalFile>;
    localHashes: Map<string, ContentHash | null>;
    rootDirId: DirId;
    direction: SyncDirection;
  }): Promise<SyncStats> {
    const hashFn = this.config.hashFn ?? computeContentHashFromBytes;
    const executeCtx: ExecuteContext = {
      api: this.api,
      meta: this.meta,
      rootDirId: ctx.rootDirId,
      localDir: this.config.localDir,
      hashFn,
    };
    const stats = await executeAll(ctx.classified, ctx.cloudSnap, executeCtx, ctx.direction);
    if (stats.failedMoves.length > 0) {
      await fallbackDeleteOldFiles(stats, this.api, this.meta);
    }
    return stats;
  }

  private async runDedupIfEnabled(
    localSnap: Map<string, LocalFile>,
    localHashes: Map<string, ContentHash | null>,
  ): Promise<{ deletedPaths: string[]; deletedCount: number }> {
    if (this.config.autoDedup === false) {
      return { deletedPaths: [], deletedCount: 0 };
    }
    const { localFileMap, absPathHashes } = buildDedupInputs(localSnap, localHashes);
    const dedupResult = await autoDedup(this.config.localDir, this.meta, {
      api: this.api,
      hashCache: absPathHashes,
      localFiles: localFileMap,
    });
    return {
      deletedPaths: dedupResult.deletedPaths,
      deletedCount: dedupResult.stats.deleted,
    };
  }

  private async postSyncCleanup(opts: {
    cloudSnap: Map<string, CloudFile>;
    localSnap: Map<string, LocalFile>;
    localHashes: Map<string, ContentHash | null>;
    stats: SyncStats;
    didFullScan: boolean;
  }): Promise<void> {
    const { cloudSnap, localSnap, localHashes, stats, didFullScan } = opts;
    if (didFullScan) cleanupStalePaths(this.meta, cloudSnap);

    const { deletedPaths: dedupDeletedPaths, deletedCount: dedupDeletedCount } =
      await this.runDedupIfEnabled(localSnap, localHashes);
    this.meta.save();

    if (this.config.autoGit !== false) {
      gitAutoCommit(this.config.localDir, {
        changedPaths: [...stats.changedPaths],
        dedupDeletedPaths,
        stats: {
          downloaded: stats.downloaded,
          uploaded: stats.uploaded,
          conflicts: stats.conflicts,
          dedupDeleted: dedupDeletedCount,
        },
      });
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
    const candidates = collectConflictCandidates(classified, cloudSnap);
    if (candidates.length === 0) return;

    const hashFn = this.config.hashFn ?? computeContentHashFromBytes;
    for (const { relPath, cloudFile } of candidates) {
      await this.refineSingleConflict({
        relPath,
        cloudFile,
        classified,
        localHashes,
        hashFn,
      });
    }
  }

  private async getCloudHashForRefine(
    relPath: string,
    cloudFile: CloudFile,
    hashFn: (data: Uint8Array, path: string) => ContentHash | null,
  ): Promise<ContentHash | null> {
    const cachedMeta = this.meta.getFileInfo(relPath);
    if (cachedMeta?.cloudContentHash && cachedMeta.cloudMtime === cloudFile.mtime) {
      return cachedMeta.cloudContentHash;
    }
    const rawData = await retryWithBackoff(() => this.api.getFileById(cloudFile.id as FileId));
    return hashFn(new Uint8Array(rawData), relPath);
  }

  private async refineSingleConflict(opts: {
    relPath: string;
    cloudFile: CloudFile;
    classified: Map<string, FileState>;
    localHashes: ReadonlyMap<string, ContentHash | null>;
    hashFn: (data: Uint8Array, path: string) => ContentHash | null;
  }): Promise<void> {
    const { relPath, cloudFile, classified, localHashes, hashFn } = opts;
    try {
      const cloudHash = await this.getCloudHashForRefine(relPath, cloudFile, hashFn);
      if (!cloudHash) return;

      const localHash = localHashes.get(relPath);
      if (!localHash) return;

      const metaRecord = this.meta.getFileInfo(relPath);
      const refined = refineCloudModified(localHash, cloudHash, metaRecord);
      applyRefinementIfChanged(relPath, refined, classified);
      this.meta.setCloudContentHash(relPath, cloudHash);
    } catch {
      // If cloud fetch fails, keep original classification
    }
  }

  close(): void {
    this.meta.close();
  }
}
