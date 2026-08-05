/**
 * Engine execution and post-sync cleanup — extracted from engine.ts to keep
 * the main engine file within the 300-line limit.
 */

import type { ContentHash, DirId, RelPath, SyncDirection } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { FileState, SyncLogMetadata } from '../types/state.js';
import type { YoudaoNoteApi } from '../api/client.js';
import type { MetadataStore } from '../metadata/store.js';
import { gc } from '../metadata/health.js';
import { executeAll } from '../execute/executor.js';
import type { SyncStats, ExecuteContext } from '../execute/executor.js';
import { fallbackDeleteOldFiles } from '../execute/move-handler.js';
import { buildDedupInputs, cleanupStalePaths, purgeExcludedMetadata } from './helpers.js';
import { computeContentHashFromBytes } from '../algo/hash.js';
import { autoDedup } from '../dedup/index.js';
import { gitAutoCommit } from '../util/git.js';
import { logger } from '../util/logger.js';
import type { SyncEngineConfig } from '../types/engine-config.js';

export async function runExecuteSync(
  ctx: {
    classified: Map<RelPath, FileState>;
    metadata?: Map<RelPath, SyncLogMetadata>;
    cloudSnap: Map<RelPath, CloudFile>;
    localSnap?: Map<RelPath, LocalFile>;
    rootDirId: DirId;
    direction: SyncDirection;
    deleteOverrides?: ReadonlyMap<RelPath, 'deleteCloud' | 'deleteLocal'> | undefined;
  },
  config: SyncEngineConfig,
  api: YoudaoNoteApi,
  meta: MetadataStore,
): Promise<SyncStats> {
  const hashFn = config.hashFn ?? computeContentHashFromBytes;
  const executeCtx: ExecuteContext = {
    api,
    meta,
    rootDirId: ctx.rootDirId,
    localDir: config.localDir,
    hashFn,
    localSnap: ctx.localSnap,
  };
  const stats = await executeAll({
    classified: ctx.classified,
    cloud: ctx.cloudSnap,
    ctx: executeCtx,
    direction: ctx.direction,
    deleteOverrides: ctx.deleteOverrides,
    metadata: ctx.metadata,
  });
  if (stats.failedMoves.length > 0) {
    await fallbackDeleteOldFiles(stats, api, meta);
  }
  return stats;
}

export async function runPostSyncCleanup(
  opts: {
    cloudSnap: Map<RelPath, CloudFile>;
    localSnap: Map<RelPath, LocalFile>;
    localHashes: Map<RelPath, ContentHash | null>;
    stats: SyncStats;
    didFullScan: boolean;
  },
  config: SyncEngineConfig,
  api: YoudaoNoteApi,
  meta: MetadataStore,
): Promise<void> {
  const { cloudSnap, localSnap, localHashes, stats, didFullScan } = opts;
  if (didFullScan) cleanupStalePaths(meta, cloudSnap, localSnap);
  const purged = purgeExcludedMetadata(meta, {
    ...(config.syncInclude !== undefined ? { include: config.syncInclude } : {}),
    ...(config.syncExclude !== undefined ? { exclude: config.syncExclude } : {}),
  });
  if (purged > 0) {
    logger.info(`Purged ${purged} excluded path(s) from metadata`);
  }
  gc(meta, config.localDir);

  const { deletedPaths: dedupDeletedPaths, deletedCount: dedupDeletedCount } =
    await runDedupIfEnabled({ localSnap, localHashes, config, api, meta });
  meta.save();

  if (config.autoGit !== false) {
    gitAutoCommit(config.localDir, {
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

async function runDedupIfEnabled(opts: {
  localSnap: Map<RelPath, LocalFile>;
  localHashes: Map<RelPath, ContentHash | null>;
  config: SyncEngineConfig;
  api: YoudaoNoteApi;
  meta: MetadataStore;
}): Promise<{ deletedPaths: string[]; deletedCount: number }> {
  const { localSnap, localHashes, config, api, meta } = opts;
  if (config.autoDedup === false) {
    return { deletedPaths: [], deletedCount: 0 };
  }
  const { localFileMap, absPathHashes } = buildDedupInputs(localSnap, localHashes);
  const dedupResult = await autoDedup(config.localDir, meta, {
    api,
    hashCache: absPathHashes,
    localFiles: localFileMap,
  });
  return {
    deletedPaths: dedupResult.deletedPaths,
    deletedCount: dedupResult.stats.deleted,
  };
}
