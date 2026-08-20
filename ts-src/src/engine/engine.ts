import { asDirId, type ContentHash, type DirId, type RelPath } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { FileState, SyncLogMetadata } from '../types/state.js';
import { YoudaoNoteApi } from '../api/client.js';
import { MetadataStore } from '../metadata/store.js';
import { healPreScan, healPostHash } from '../metadata/health.js';
import { healCloudMtimeBaseline } from '../metadata/heal-cloud-mtime.js';
import { emptyStats } from '../execute/executor.js';
import type { SyncStats } from '../execute/executor.js';
import { filterByDirection } from './helpers.js';
import { diagnoseDryrun, dryRunStats } from './helpers-dryrun.js';
import { initXxhash } from '../algo/hash.js';
import { SyncLock } from '../util/lock.js';
import { logger } from '../util/logger.js';
import { runCloudScanPhase } from './cloud-scan-phase.js';
import { runLocalScanPhase } from './local-scan-phase.js';
import { runClassifyAndRefine } from './classify-phase.js';
import {
  collectDeleteOverrides,
  collectPendingDeletes,
  countCloudLinkedFiles,
  stampGuardrailChecks,
  suspendForDeleteThreshold,
} from './guardrail-helpers.js';
import { runExecuteSync, runPostSyncCleanup } from './execute.js';
export type { SyncDirection } from '../types/common.js';
export type { SyncEngineConfig } from '../types/engine-config.js';
export { collectDeleteOverrides, stampGuardrailChecks } from './guardrail-helpers.js';
import type { SyncEngineConfig } from '../types/engine-config.js';
import type { SyncProfiler } from '../perf/profiler.js';

export interface SyncResult {
  stats: SyncStats;
  classified: Map<RelPath, FileState>;
  /** ok = executed or dry-run preview; suspended = delete threshold; aborted = empty cloud */
  status: 'ok' | 'suspended' | 'aborted';
  reason?: string;
  reportPath?: string;
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

    this.p?.beginPhase('loginByCookies');
    const loginErr = this.api.loginByCookies();
    this.p?.endPhase();
    if (loginErr) throw new Error(`Login failed: ${loginErr}`);

    const lock = new SyncLock(this.config.localDir);
    if (!this.config.dryRun && !lock.acquire()) {
      logger.error('Cannot acquire sync lock — another sync process is running');
      return {
        stats: Object.freeze(emptyStats()),
        classified: new Map() as Map<RelPath, FileState>,
        status: 'aborted',
        reason: 'lock_held',
      };
    }

    try {
      return await this.syncInner();
    } finally {
      if (!this.config.dryRun) lock.release();
    }
  }

  // eslint-disable-next-line max-lines-per-function, complexity
  private async syncInner(): Promise<SyncResult> {
    const { localDir, dryRun } = this.config;
    if (!dryRun) {
      this.p?.beginPhase('healPreScan');
      healPreScan(this.meta, localDir, true);
      this.p?.endPhase();
    }

    const { cloudSnap, localSnap, localHashes, rootDirId, didFullScan } =
      await this.obtainSnapshots(localDir);

    const maxDeletes = this.config.maxDeletesPerSync ?? 5;
    // Abort empty-cloud only when many linked rows would look cloud-deleted.
    // Smaller linked counts fall through to the delete-threshold guardrail.
    if (cloudSnap.size === 0 && localSnap.size > 0) {
      const linked = countCloudLinkedFiles(this.meta);
      if (linked > maxDeletes) {
        logger.error(
          `Cloud returned empty list but metadata has ${linked} cloud-linked files ` +
            `(limit ${maxDeletes}) — aborting sync to prevent mass deletion`,
        );
        return {
          stats: Object.freeze(emptyStats()),
          classified: new Map() as Map<RelPath, FileState>,
          status: 'aborted',
          reason: 'empty_cloud_response',
        };
      }
    }

    if (!dryRun) {
      this.p?.beginPhase('healPostHash');
      healPostHash(this.meta, localDir, localHashes, true);
      this.p?.endPhase();
    }
    const { classified, metadata } = await this.classifyAndRefine(
      cloudSnap,
      localSnap,
      localHashes,
    );
    const direction = this.config.direction ?? 'both';
    if (direction !== 'both') filterByDirection(classified, direction);
    const deleteOverrides = this.config.propagateDeletes
      ? collectDeleteOverrides(classified)
      : undefined;

    const pendingDeletes = collectPendingDeletes(classified, deleteOverrides);
    if (pendingDeletes.length > maxDeletes) {
      return suspendForDeleteThreshold({
        classified,
        meta: this.meta,
        localDir,
        localHashes,
        deleteOverrides,
        pendingDeletes,
        maxDeletes,
      });
    }

    stampGuardrailChecks(metadata, {
      empty_cloud: 'pass',
      delete_threshold: 'pass',
      pendingDeletes: pendingDeletes.length,
      maxDeletes,
    });

    if (dryRun) {
      const reportPath = diagnoseDryrun(classified, this.meta, {
        reportBaseDir: localDir,
        localHashes,
        deleteOverrides,
      });
      return {
        stats: dryRunStats(classified, deleteOverrides),
        classified,
        status: 'ok',
        ...(reportPath !== undefined ? { reportPath } : {}),
      };
    }

    const stats = await runExecuteSync(
      { classified, metadata, cloudSnap, localSnap, rootDirId, direction, deleteOverrides },
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
    return { stats, classified, status: 'ok' };
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
    const local = await this.scanLocalPhase(localDir, cloudSnap, rootDirId, didFullScan);
    return {
      cloudSnap,
      localSnap: local.localSnap,
      localHashes: local.localHashes,
      rootDirId,
      didFullScan: didFullScan || local.didFullScan,
    };
  }

  /** Overridable in tests. */
  private scanCloudPhase(
    rootDirId: DirId,
  ): Promise<{ cloudSnap: Map<RelPath, CloudFile>; didFullScan: boolean }> {
    return runCloudScanPhase({
      api: this.api,
      meta: this.meta,
      rootDirId,
      skipDesktopSeed: !!this.config.api,
      dryRun: !!this.config.dryRun,
      syncInclude: this.config.syncInclude,
      syncExclude: this.config.syncExclude,
      profiler: this.p,
    });
  }

  /** Overridable in tests. */
  private scanLocalPhase(
    localDir: string,
    cloudSnap: Map<RelPath, CloudFile>,
    rootDirId: DirId,
    didFullScan: boolean,
  ): Promise<{
    localSnap: Map<RelPath, LocalFile>;
    localHashes: Map<RelPath, ContentHash | null>;
    didFullScan: boolean;
  }> {
    return runLocalScanPhase({
      meta: this.meta,
      localDir,
      cloudSnap,
      api: this.api,
      rootDirId,
      didFullScan,
      syncInclude: this.config.syncInclude,
      syncExclude: this.config.syncExclude,
      profiler: this.p,
    });
  }

  private classifyAndRefine(
    cloudSnap: Map<RelPath, CloudFile>,
    localSnap: Map<RelPath, LocalFile>,
    localHashes: Map<RelPath, ContentHash | null>,
  ): Promise<{ classified: Map<RelPath, FileState>; metadata: Map<RelPath, SyncLogMetadata> }> {
    healCloudMtimeBaseline(this.meta, cloudSnap, true);
    return runClassifyAndRefine({
      api: this.api,
      meta: this.meta,
      cloudSnap,
      localSnap,
      localHashes,
      syncInclude: this.config.syncInclude,
      syncExclude: this.config.syncExclude,
      hashFn: this.config.hashFn,
      profiler: this.p,
    });
  }

  /** Collect sync items without executing — for dry-run and external tools. */
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
    const { classified } = await this.classifyAndRefine(cloudSnap, localSnap, localHashes);
    const direction = this.config.direction ?? 'both';
    if (direction !== 'both') filterByDirection(classified, direction);
    return { classified, cloudSnap, localSnap };
  }
  close(): void {
    this.meta.close();
  }
}
