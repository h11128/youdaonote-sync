import { dirname } from 'node:path';
import { asDirId, type ContentHash, type DirId, type RelPath } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { FileState } from '../types/state.js';
import { YoudaoNoteApi } from '../api/client.js';
import { MetadataStore } from '../metadata/store.js';
import { heal } from '../metadata/health.js';
import { scanCloud } from '../scan/cloud.js';
import { scanLocalParallel } from '../scan/local.js';
import { classifyAll } from '../classify/classify.js';
import { detectMoves } from '../classify/moves.js';
import { calibrateMetadata } from '../classify/calibrate.js';
import { emptyStats } from '../execute/executor.js';
import type { SyncStats } from '../execute/executor.js';
import {
  diagnoseDryrun,
  dryRunStats,
  filterCloudSnap,
  filterByDirection,
  warmupHashCache,
} from './helpers.js';
import { refineAllConflicts } from './refine.js';
import { computeContentHashFromBytes, computeHashesConcurrent, initXxhash } from '../algo/hash.js';
import type { HashFileEntry } from '../algo/hash.js';
import { SyncLock } from '../util/lock.js';
import { discardOrphanDuplicates } from '../dedup/index.js';
import { tryCachedCloudScan, saveScanVersion, fetchCurrentVersion } from '../scan/cloud-cache.js';
import { runExecuteSync, runPostSyncCleanup } from './execute.js';
export type { SyncDirection } from '../types/common.js';
export type { SyncEngineConfig } from '../types/engine-config.js';
import type { SyncEngineConfig } from '../types/engine-config.js';
import type { SyncProfiler } from '../perf/profiler.js';

export interface SyncResult {
  stats: SyncStats;
  classified: Map<RelPath, FileState>;
}

/**
 * The sync engine: Init → Heal → Scan → Calibrate → Moves → Orphan Discard
 *   → Warmup → Classify → Refine → Filter → Execute → Cleanup → GC → Dedup → Git.
 */
export class SyncEngine {
  private api: YoudaoNoteApi;
  private meta: MetadataStore;
  private config: SyncEngineConfig;
  private readonly p: SyncProfiler | undefined;

  private static readonly STATE_ROOT_DIR_ID = 'root_dir_id';

  constructor(config: SyncEngineConfig) {
    this.config = config;
    this.api = config.api ?? new YoudaoNoteApi(config.cookiesPath);
    this.meta = config.meta ?? new MetadataStore(config.metadataPath);
    this.p = config.profiler;

    // Restore persisted rootDirId to avoid a ~1s API call
    this.initRootIdCache();
  }

  private initRootIdCache(): void {
    const api = this.api as Partial<YoudaoNoteApi>;
    if (typeof api.setPersistedRootId !== 'function') return;
    const saved = this.meta.getState(SyncEngine.STATE_ROOT_DIR_ID);
    if (saved) api.setPersistedRootId(asDirId(saved));
    if (typeof api.setOnRootIdResolved === 'function') {
      api.setOnRootIdResolved((id) => {
        this.meta.setState(SyncEngine.STATE_ROOT_DIR_ID, id);
      });
    }
  }

  async sync(): Promise<SyncResult> {
    this.p?.beginPhase('initXxhash');
    await initXxhash();
    this.p?.endPhase();

    // 0. Login
    this.p?.beginPhase('loginByCookies');
    const loginErr = this.api.loginByCookies();
    this.p?.endPhase();
    if (loginErr) throw new Error(`Login failed: ${loginErr}`);

    const lock = new SyncLock(this.config.localDir);
    if (!this.config.dryRun && !lock.acquire()) {
      console.error('Cannot acquire sync lock — another sync process is running');
      return { stats: emptyStats(), classified: new Map() as Map<RelPath, FileState> };
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
      const configDir = dirname(this.config.metadataPath);
      diagnoseDryrun(classified, this.meta, configDir);
      return { stats: dryRunStats(classified), classified };
    }

    const stats = await runExecuteSync(
      { classified, cloudSnap, localSnap, rootDirId, direction },
      this.config,
      this.api,
      this.meta,
    );
    await runPostSyncCleanup(
      { cloudSnap, localSnap, localHashes, stats, didFullScan },
      this.config,
      this.api,
      this.meta,
    );
    return { stats, classified };
  }

  private async obtainSnapshots(localDir: string): Promise<{
    cloudSnap: Map<RelPath, CloudFile>;
    localSnap: Map<RelPath, LocalFile>;
    localHashes: Map<RelPath, ContentHash | null>;
    rootDirId: DirId;
    didFullScan: boolean;
  }> {
    this.p?.beginPhase('getRootId');
    const rootDirId = await this.api.getRootId();
    this.p?.endPhase();

    const { cloudSnap, didFullScan } = await this.scanCloudPhase(rootDirId);
    const { localSnap, localHashes } = await this.scanLocalPhase(localDir, cloudSnap);
    return { cloudSnap, localSnap, localHashes, rootDirId, didFullScan };
  }

  private buildScanOpts(): { include?: string[]; exclude?: string[] } {
    const opts: { include?: string[]; exclude?: string[] } = {};
    if (this.config.syncInclude) opts.include = this.config.syncInclude;
    if (this.config.syncExclude) opts.exclude = this.config.syncExclude;
    return opts;
  }

  private async scanCloudPhase(rootDirId: DirId): Promise<{
    cloudSnap: Map<RelPath, CloudFile>;
    didFullScan: boolean;
  }> {
    this.p?.beginPhase('cloudScan');
    const cached = await tryCachedCloudScan({
      api: this.api,
      meta: this.meta,
      skipDesktopSeed: !!this.config.api,
    });
    let cloudSnap: Map<RelPath, CloudFile>;
    let didFullScan = false;
    if (cached) {
      cloudSnap = cached;
      this.p?.endPhase(`${cloudSnap.size} entries (cached)`);
    } else {
      cloudSnap = await scanCloud(this.api, rootDirId);
      saveScanVersion(this.meta, cloudSnap, await fetchCurrentVersion(this.api));
      didFullScan = true;
      this.p?.endPhase(`${cloudSnap.size} entries (full)`);
    }

    this.p?.beginPhase('filterCloudSnap');
    this.applyCloudFilters(cloudSnap);
    this.p?.endPhase(`→ ${cloudSnap.size} after filter`);
    return { cloudSnap, didFullScan };
  }

  private applyCloudFilters(cloudSnap: Map<RelPath, CloudFile>): void {
    const scanOpts = this.buildScanOpts();
    if (scanOpts.include?.length || scanOpts.exclude?.length) {
      filterCloudSnap(cloudSnap, scanOpts);
    }
    for (const [path] of [...cloudSnap]) {
      if ((path.split('/').pop() ?? '').includes('.conflict.')) cloudSnap.delete(path);
    }
  }

  private async scanLocalPhase(
    localDir: string,
    cloudSnap: Map<RelPath, CloudFile>,
  ): Promise<{
    localSnap: Map<RelPath, LocalFile>;
    localHashes: Map<RelPath, ContentHash | null>;
  }> {
    this.p?.beginPhase('scanLocalParallel');
    const localSnap = await scanLocalParallel(localDir, '', this.buildScanOpts());
    this.p?.endPhase(`${localSnap.size} entries`);

    this.p?.beginPhase('calibrateMetadata');
    const localHashes = new Map<RelPath, ContentHash | null>();
    const calibrated = calibrateMetadata(this.meta, cloudSnap, localSnap, localHashes);
    this.p?.endPhase(`${calibrated} calibrated, ${localHashes.size} hashes inline`);

    this.p?.beginPhase('computeHashesConcurrent');
    const toHash: HashFileEntry[] = [];
    for (const [relPath, local] of localSnap) {
      if (!local.isDir && !localHashes.has(relPath)) {
        toHash.push({
          relPath,
          absPath: local.path,
          mtime: local.mtime,
          size: local.size,
        });
      }
    }
    const hashResult = await computeHashesConcurrent(toHash, localHashes, { cache: this.meta });
    this.p?.endPhase(`${hashResult.cacheHits} cached, ${hashResult.computed} computed`);

    this.p?.beginPhase('warmupHashCache');
    await warmupHashCache(cloudSnap, localSnap, localHashes);
    this.p?.endPhase(`${localHashes.size} total hashes`);

    return { localSnap, localHashes };
  }

  private async classifyAndRefine(
    cloudSnap: Map<RelPath, CloudFile>,
    localSnap: Map<RelPath, LocalFile>,
    localHashes: Map<RelPath, ContentHash | null>,
  ): Promise<Map<RelPath, FileState>> {
    this.p?.beginPhase('classifyAll');
    const metaSnap = this.meta.getAllFiles();
    const classified = classifyAll(cloudSnap, localSnap, metaSnap, localHashes);
    this.p?.endPhase(`${classified.size} entries`);

    this.p?.beginPhase('detectMoves');
    const moveCount = this.applyMoveDetection(classified, localHashes, metaSnap, cloudSnap);
    this.p?.endPhase(`${moveCount} moves`);

    this.p?.beginPhase('discardOrphanDuplicates');
    let orphanCount = 0;
    for (const orphanPath of discardOrphanDuplicates(cloudSnap, localSnap, localHashes)) {
      classified.set(orphanPath, { kind: 'gone' });
      orphanCount++;
    }
    this.p?.endPhase(`${orphanCount} discarded`);

    this.p?.beginPhase('refineAllConflicts');
    await refineAllConflicts({
      classified,
      cloudSnap,
      localHashes,
      hashFn: this.config.hashFn ?? computeContentHashFromBytes,
      meta: this.meta,
      api: this.api,
    });
    this.p?.endPhase();

    return classified;
  }

  private applyMoveDetection(
    classified: Map<RelPath, FileState>,
    localHashes: Map<RelPath, ContentHash | null>,
    metaSnap: ReadonlyMap<RelPath, { contentHash?: ContentHash | null }>,
    cloudSnap: Map<RelPath, CloudFile>,
  ): number {
    const classifiedWithHash = new Map<RelPath, { state: FileState; hash: ContentHash | null }>();
    for (const [path, state] of classified) {
      const hash = localHashes.get(path) ?? metaSnap.get(path)?.contentHash ?? null;
      classifiedWithHash.set(path, { state, hash });
    }
    let count = 0;
    for (const [path, movedState] of detectMoves(classifiedWithHash, this.meta, cloudSnap)) {
      classified.set(path, movedState);
      count++;
    }
    return count;
  }

  /**
   * Collect sync items without executing — for dry-run and external tools.
   * Returns the classified map and snapshots.
   */
  async collectItems(): Promise<{
    classified: Map<RelPath, FileState>;
    cloudSnap: Map<RelPath, CloudFile>;
    localSnap: Map<RelPath, LocalFile>;
  }> {
    this.p?.beginPhase('initXxhash');
    await initXxhash();
    this.p?.endPhase();

    this.p?.beginPhase('loginByCookies');
    const loginErr = this.api.loginByCookies();
    this.p?.endPhase();
    if (loginErr) throw new Error(`Login failed: ${loginErr}`);

    const { cloudSnap, localSnap, localHashes } = await this.obtainSnapshots(this.config.localDir);
    const classified = await this.classifyAndRefine(cloudSnap, localSnap, localHashes);
    const direction = this.config.direction ?? 'both';
    if (direction !== 'both') filterByDirection(classified, direction);
    return { classified, cloudSnap, localSnap };
  }

  close(): void {
    this.meta.close();
  }
}
