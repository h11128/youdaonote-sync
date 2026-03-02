import { join } from 'node:path';
import type { DirId, ContentHash } from './types/common.js';
import type { CloudFile } from './types/scan.js';
import type { FileState } from './types/state.js';
import { stateToAction } from './types/state.js';
import { YoudaoNoteApi } from './api/client.js';
import { MetadataStore } from './metadata/store.js';
import { scanCloud } from './scan/cloud.js';
import { scanLocal } from './scan/local.js';
import { classifyAll } from './classify/classify.js';
import { detectMoves } from './classify/moves.js';
import { executeAll, emptyStats } from './execute/executor.js';
import type { SyncStats, ExecuteContext } from './execute/executor.js';
import { computeContentHashFromBytes, computeContentHashFromFile } from './hash.js';

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
 * The three-phase sync engine: Scan → Classify → Execute.
 *
 * This replaces the Python engine's 20-step process with a clean 3-step pipeline.
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
    // 0. Login
    const loginErr = this.api.loginByCookies();
    if (loginErr) throw new Error(`Login failed: ${loginErr}`);

    // 1. Scan
    const rootDirId = await this.api.getRootId();
    const scanOpts: { include?: string[]; exclude?: string[] } = {};
    if (this.config.syncInclude) scanOpts.include = this.config.syncInclude;
    if (this.config.syncExclude) scanOpts.exclude = this.config.syncExclude;

    const [cloudSnap, localSnap] = await Promise.all([
      scanCloud(this.api, rootDirId),
      Promise.resolve(scanLocal(this.config.localDir, '', scanOpts)),
    ]);

    // Build metadata map
    const metaSnap = this.meta.getAllFiles();

    // Build local hash map from scan results
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
    const moves = detectMoves(classifiedWithHash);
    for (const [path, movedState] of moves) {
      classified.set(path, movedState);
    }

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

    // Save metadata
    this.meta.save();

    return { stats, classified };
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
