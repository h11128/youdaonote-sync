import { extname } from 'node:path';
import type { ContentHash, DirId, FileId, SyncDirection } from './types/common.js';
import type { CloudFile, LocalFile } from './types/scan.js';
import type { FileState } from './types/state.js';
import { stateToAction } from './types/state.js';
import type { SyncAction } from './types/state.js';
import { YoudaoNoteApi } from './api/client.js';
import { MetadataStore } from './metadata/store.js';
import { heal } from './metadata/health.js';
import { scanCloud } from './scan/cloud.js';
import { scanLocal, patternToRegex } from './scan/local.js';
import { classifyAll } from './classify/classify.js';
import { detectMoves } from './classify/moves.js';
import { calibrateMetadata } from './classify/calibrate.js';
import { refineCloudModified } from './classify/refine.js';
import { executeAll, fallbackDeleteOldFiles } from './execute/executor.js';
import type { SyncStats, ExecuteContext } from './execute/executor.js';
import { diagnoseDryrun, dryRunStats } from './engine-helpers.js';
import { computeContentHashFromBytes, computeContentHashFromFile, initXxhash } from './hash.js';
import { SyncLock } from './lock.js';
import { autoDedup, discardOrphanDuplicates } from './dedup/index.js';
import { gitAutoCommit } from './git.js';
import { retryWithBackoff } from './api/retry.js';
import { tryCachedCloudScan, saveScanVersion, fetchCurrentVersion } from './scan/cloud-cache.js';

const HASHABLE_EXTS = new Set([
  '.md',
  '.txt',
  '.html',
  '.htm',
  '.xml',
  '.json',
  '.css',
  '.js',
  '.csv',
]);

function isConflictCandidate(state: FileState): boolean {
  return state.kind === 'cloudModifiedContent' || state.kind === 'conflict';
}

function collectConflictCandidates(
  classified: Map<string, FileState>,
  cloudSnap: ReadonlyMap<string, CloudFile>,
): { relPath: string; cloudFile: CloudFile }[] {
  const candidates: { relPath: string; cloudFile: CloudFile }[] = [];
  for (const [relPath, state] of classified) {
    if (!isConflictCandidate(state)) continue;
    if (!HASHABLE_EXTS.has(extname(relPath).toLowerCase())) continue;
    const cf = cloudSnap.get(relPath);
    if (cf) candidates.push({ relPath, cloudFile: cf });
  }
  return candidates;
}

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
    this.warmupHashCache(cloudSnap, localSnap, localHashes);
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

  private buildDedupInputs(
    localSnap: Map<string, LocalFile>,
    localHashes: Map<string, ContentHash | null>,
  ): {
    localFileMap: Map<string, { path: string; mtime: number; isDir: boolean }>;
    absPathHashes: Map<string, ContentHash>;
  } {
    const localFileMap = new Map<string, { path: string; mtime: number; isDir: boolean }>();
    const absPathHashes = new Map<string, ContentHash>();
    for (const [rel, info] of localSnap) {
      localFileMap.set(rel, { path: info.path, mtime: info.mtime, isDir: info.isDir });
      const h = localHashes.get(rel);
      if (h) absPathHashes.set(info.path, h);
    }
    return { localFileMap, absPathHashes };
  }

  private async runDedupIfEnabled(
    localSnap: Map<string, LocalFile>,
    localHashes: Map<string, ContentHash | null>,
  ): Promise<{ deletedPaths: string[]; deletedCount: number }> {
    if (this.config.autoDedup === false) {
      return { deletedPaths: [], deletedCount: 0 };
    }
    const { localFileMap, absPathHashes } = this.buildDedupInputs(localSnap, localHashes);
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
    if (didFullScan) this.cleanupStalePaths(cloudSnap);

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
   * Pre-compute content hashes for files on both sides (warm the cache).
   * Only computes for hashable extensions that haven't been computed yet.
   */
  private warmupHashCache(
    cloudSnap: ReadonlyMap<string, CloudFile>,
    localSnap: ReadonlyMap<string, LocalFile>,
    localHashes: Map<string, ContentHash | null>,
  ): void {
    const toCompute: { relPath: string; absPath: string }[] = [];
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

  private applyRefinementIfChanged(
    relPath: string,
    refined: FileState,
    classified: Map<string, FileState>,
  ): void {
    const current = classified.get(relPath);
    if (current && refined.kind !== current.kind) {
      classified.set(relPath, refined);
    }
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
      this.applyRefinementIfChanged(relPath, refined, classified);
      this.meta.setCloudContentHash(relPath, cloudHash);
    } catch {
      // If cloud fetch fails, keep original classification
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

  close(): void {
    this.meta.close();
  }
}

/**
 * Filter cloud snapshot by include/exclude patterns (matches local scan filtering).
 * Removes entries that don't match include patterns or that match exclude patterns.
 */
export function filterCloudSnap(
  cloudSnap: Map<string, CloudFile>,
  opts: { include?: string[]; exclude?: string[] },
): void {
  const includeRes = (opts.include ?? []).map(patternToRegex);
  const excludeRes = (opts.exclude ?? []).map(patternToRegex);

  for (const path of [...cloudSnap.keys()]) {
    if (excludeRes.some((re) => re.test(path))) {
      cloudSnap.delete(path);
      continue;
    }
    if (includeRes.length > 0 && !includeRes.some((re) => re.test(path))) {
      cloudSnap.delete(path);
    }
  }
}

/**
 * Filter classified entries by sync direction.
 * 'pull' keeps only downloads/conflicts; 'push' keeps only uploads.
 * Non-matching entries are set to 'gone' (skipped).
 */
export function filterByDirection(
  classified: Map<string, FileState>,
  direction: 'pull' | 'push',
): void {
  const allowedActions: Set<SyncAction> =
    direction === 'pull' ? new Set(['download', 'conflict']) : new Set(['upload']);

  for (const [path, state] of classified) {
    const action = stateToAction(state);
    if (action === 'skip' || action === 'move') continue;
    if (!allowedActions.has(action)) {
      classified.set(path, { kind: 'gone' });
    }
  }
}
