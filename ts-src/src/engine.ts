import { extname } from 'node:path';
import type { DirId, ContentHash, FileId } from './types/common.js';
import type { CloudFile } from './types/scan.js';
import type { FileState } from './types/state.js';
import { stateToAction } from './types/state.js';
import { YoudaoNoteApi } from './api/client.js';
import { MetadataStore } from './metadata/store.js';
import { heal } from './metadata/health.js';
import { scanCloud } from './scan/cloud.js';
import { scanLocal } from './scan/local.js';
import { classifyAll } from './classify/classify.js';
import { detectMoves } from './classify/moves.js';
import { refineCloudModified } from './classify/refine.js';
import { executeAll, emptyStats } from './execute/executor.js';
import type { SyncStats, ExecuteContext } from './execute/executor.js';
import { computeContentHashFromBytes, computeContentHashFromFile, initXxhash } from './hash.js';
import { SyncLock } from './lock.js';

const HASHABLE_EXTS = new Set(['.md', '.txt', '.html', '.htm', '.xml', '.json']);

export interface SyncEngineConfig {
  cookiesPath: string;
  metadataPath: string;
  localDir: string;
  syncInclude?: string[] | undefined;
  syncExclude?: string[] | undefined;
  dryRun?: boolean | undefined;
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
 * The sync engine: Init → Heal → Scan → Classify → Refine → Execute.
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
    // 0b. Self-heal metadata before sync
    if (!this.config.dryRun) {
      heal(this.meta, this.config.localDir, true);
    }

    // 1. Scan
    const rootDirId = await this.api.getRootId();
    const scanOpts: { include?: string[]; exclude?: string[] } = {};
    if (this.config.syncInclude) scanOpts.include = this.config.syncInclude;
    if (this.config.syncExclude) scanOpts.exclude = this.config.syncExclude;

    const [cloudSnap, localSnap] = await Promise.all([
      scanCloud(this.api, rootDirId),
      Promise.resolve(scanLocal(this.config.localDir, '', scanOpts)),
    ]);

    const metaSnap = this.meta.getAllFiles();

    const localHashes = new Map<string, ContentHash | null>();
    for (const [relPath, local] of localSnap) {
      if (!local.isDir) {
        const hash = computeContentHashFromFile(local.path);
        localHashes.set(relPath, hash);
      }
    }

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

    // 2c. Refine conflicts — download cloud content hash to distinguish
    //     mtime-only changes, converged edits, and true conflicts
    await this.refineConflicts(classified, cloudSnap, localHashes);

    // 3. Execute
    if (this.config.dryRun) {
      return { stats: dryRunStats(classified), classified };
    }

    const hashFn = this.config.hashFn ?? computeContentHashFromBytes;
    const ctx: ExecuteContext = {
      api: this.api,
      meta: this.meta,
      rootDirId,
      localDir: this.config.localDir,
      hashFn,
    };

    const stats = await executeAll(classified, cloudSnap, ctx);

    this.meta.save();

    return { stats, classified };
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
        const rawData = await this.api.getFileById(cloudFile.id as FileId);
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

        // Cache cloud content hash for future use
        this.meta.setCloudContentHash(relPath, cloudHash);
      } catch {
        // If cloud fetch fails, keep original classification
      }
    }
  }

  close(): void {
    this.meta.close();
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
