import { extname } from 'node:path';
import type { ContentHash, FileId, SyncDirection } from './types/common.js';
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
import { executeAll, emptyStats, fallbackDeleteOldFiles } from './execute/executor.js';
import type { SyncStats, ExecuteContext } from './execute/executor.js';
import { computeContentHashFromBytes, computeContentHashFromFile, initXxhash } from './hash.js';
import { SyncLock } from './lock.js';
import { autoDedup, discardOrphanDuplicates } from './dedup/index.js';
import { gitAutoCommit } from './git.js';
import { retryWithBackoff } from './api/retry.js';
import {
  tryCachedCloudScan, saveScanVersion, fetchCurrentVersion,
} from './scan/cloud-cache.js';

const HASHABLE_EXTS = new Set(['.md', '.txt', '.html', '.htm', '.xml', '.json', '.css', '.js', '.csv']);

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
    let didFullScan = false;
    const cacheDeps = {
      api: this.api,
      meta: this.meta,
      skipDesktopSeed: !!this.config.api,
    };
    const cachedCloud = await tryCachedCloudScan(cacheDeps);
    if (cachedCloud) {
      cloudSnap = cachedCloud;
    } else {
      cloudSnap = await scanCloud(this.api, rootDirId);
      saveScanVersion(this.meta, cloudSnap, await fetchCurrentVersion(this.api));
      didFullScan = true;
    }

    // Filter cloud files by sync_include/sync_exclude (matches Python)
    if (scanOpts.include?.length || scanOpts.exclude?.length) {
      filterCloudSnap(cloudSnap, scanOpts);
    }

    // Filter out .conflict. backup files from cloud snapshot (matches Python)
    for (const [path] of [...cloudSnap]) {
      const name = path.split('/').pop() ?? '';
      if (name.includes('.conflict.')) cloudSnap.delete(path);
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
      diagnoseDryrun(classified, this.meta);
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

    const stats = await executeAll(classified, cloudSnap, ctx, direction);

    // 3b. Fallback: delete old cloud files for failed moves that were uploaded
    if (stats.failedMoves.length > 0) {
      await fallbackDeleteOldFiles(stats, this.api, this.meta);
    }

    // 4. Post-sync: cleanup stale metadata (only after full scan — cached scan may be incomplete)
    if (didFullScan) {
      this.cleanupStalePaths(cloudSnap);
    }

    // 5. Post-sync: auto-dedup
    let dedupDeletedPaths: string[] = [];
    let dedupDeletedCount = 0;
    if (this.config.autoDedup !== false) {
      const localFileMap = new Map<string, { path: string; mtime: number; isDir: boolean }>();
      const absPathHashes = new Map<string, ContentHash>();
      for (const [rel, info] of localSnap) {
        localFileMap.set(rel, { path: info.path, mtime: info.mtime, isDir: info.isDir });
        const h = localHashes.get(rel);
        if (h) absPathHashes.set(info.path, h);
      }
      const dedupResult = await autoDedup(localDir, this.meta, {
        api: this.api,
        hashCache: absPathHashes,
        localFiles: localFileMap,
      });
      dedupDeletedPaths = dedupResult.deletedPaths;
      dedupDeletedCount = dedupResult.stats.deleted;
    }

    this.meta.save();

    // 6. Post-sync: git auto-commit
    if (this.config.autoGit !== false) {
      gitAutoCommit(localDir, {
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
        // Use cached cloud content hash if cloudMtime matches (avoids extra download)
        const cachedMeta = this.meta.getFileInfo(relPath);
        let cloudHash: ContentHash | null = null;
        if (cachedMeta?.cloudContentHash && cachedMeta.cloudMtime === cloudFile.mtime) {
          cloudHash = cachedMeta.cloudContentHash;
        } else {
          const rawData = await retryWithBackoff(() => this.api.getFileById(cloudFile.id as FileId));
          const data = new Uint8Array(rawData);
          cloudHash = hashFn(data, relPath);
        }
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
    if (excludeRes.some(re => re.test(path))) { cloudSnap.delete(path); continue; }
    if (includeRes.length > 0 && !includeRes.some(re => re.test(path))) { cloudSnap.delete(path); }
  }
}


/**
 * Filter classified entries by sync direction.
 * 'pull' keeps only downloads/conflicts; 'push' keeps only uploads.
 * Non-matching entries are set to 'gone' (skipped).
 */
export function filterByDirection(classified: Map<string, FileState>, direction: 'pull' | 'push'): void {
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

/**
 * Diagnose suspicious UPLOADs in dry-run results (matches Python diagnose_dryrun).
 * Warns when a file marked for upload has metadata suggesting it was previously synced.
 */
function diagnoseDryrun(
  classified: Map<string, FileState>,
  meta: MetadataStore,
): void {
  const warnings: Array<{ path: string; reasons: string[] }> = [];

  for (const [path, state] of classified) {
    const action = stateToAction(state);
    if (action !== 'upload') continue;

    const info = meta.getFileInfo(path);
    if (!info) continue;

    const reasons: string[] = [];
    if (!info.fileId && info.cloudMtime > 0) {
      reasons.push('metadata 有记录但 file_id 为空');
    }
    if (info.lastSyncAt > 0) {
      const d = new Date(info.lastSyncAt * 1000);
      reasons.push(`曾在 ${d.toISOString().slice(0, 16).replace('T', ' ')} 同步过`);
    }
    if (reasons.length > 0) {
      warnings.push({ path, reasons });
    }
  }

  if (warnings.length === 0) return;

  console.log();
  console.log('='.repeat(60));
  console.log(`  ⚠ 可疑 UPLOAD 诊断（${warnings.length} 个文件）`);
  console.log('='.repeat(60));
  console.log('  以下文件标记为上传，但 metadata 显示它们曾与云端关联。');
  console.log();
  for (const { path, reasons } of warnings) {
    console.log(`  ${path}`);
    for (const r of reasons) console.log(`    → ${r}`);
  }
  console.log();
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
