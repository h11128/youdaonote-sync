/**
 * Local scan + calibrate + hash warmup — extracted from SyncEngine.
 */
import type { ContentHash, DirId, RelPath } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { MetadataStore } from '../metadata/store.js';
import type { DirBrowser } from '../scan/cloud.js';
import { scanLocalParallel } from '../scan/local.js';
import { hydrateLocalOnlyFromParents } from '../scan/hydrate-cached-cloud.js';
import { replaceCloudSnapFromLiveScan } from './cloud-scan-phase.js';
import { logger } from '../util/logger.js';
import { calibrateMetadata } from '../classify/calibrate.js';
import { computeHashesConcurrent } from '../algo/hash.js';
import type { HashFileEntry } from '../algo/hash.js';
import type { SyncProfiler } from '../perf/profiler.js';

export interface LocalScanPhaseOpts {
  meta: MetadataStore;
  localDir: string;
  cloudSnap: Map<RelPath, CloudFile>;
  api?:
    | (DirBrowser & { listRecent?: (limit: number) => Promise<Record<string, unknown>[]> })
    | undefined;
  rootDirId?: DirId | undefined;
  didFullScan?: boolean | undefined;
  syncInclude?: string[] | undefined;
  syncExclude?: string[] | undefined;
  profiler?: SyncProfiler | undefined;
}

export async function runLocalScanPhase(opts: LocalScanPhaseOpts): Promise<{
  localSnap: Map<RelPath, LocalFile>;
  localHashes: Map<RelPath, ContentHash | null>;
  didFullScan: boolean;
}> {
  const p = opts.profiler;
  const scanOpts: { include?: string[]; exclude?: string[] } = {};
  if (opts.syncInclude) scanOpts.include = opts.syncInclude;
  if (opts.syncExclude) scanOpts.exclude = opts.syncExclude;

  p?.beginPhase('scanLocalParallel');
  const localSnap = await scanLocalParallel(opts.localDir, '', scanOpts);
  p?.endPhase(`${localSnap.size} entries`);

  // Hash before calibrate so Case2 can re-link empty-fileId rows in the same pass.
  p?.beginPhase('computeHashesConcurrent');
  const localHashes = new Map<RelPath, ContentHash | null>();
  const toHash: HashFileEntry[] = [];
  for (const [relPath, local] of localSnap) {
    if (!local.isDir) {
      toHash.push({
        relPath,
        absPath: local.path,
        mtime: local.mtime,
        size: local.size,
      });
    }
  }
  const hashResult = await computeHashesConcurrent(toHash, localHashes, { cache: opts.meta });
  p?.endPhase(`${hashResult.cacheHits} cached, ${hashResult.computed} computed`);

  const hydratedFull = await maybeHydrateCachedCloud(opts, localSnap, p);

  p?.beginPhase('calibrateMetadata');
  const calibrated = calibrateMetadata(opts.meta, opts.cloudSnap, localSnap, localHashes);
  p?.endPhase(`${calibrated} calibrated`);

  return { localSnap, localHashes, didFullScan: !!opts.didFullScan || hydratedFull };
}

async function maybeHydrateCachedCloud(
  opts: LocalScanPhaseOpts,
  localSnap: Map<RelPath, LocalFile>,
  p: SyncProfiler | undefined,
): Promise<boolean> {
  if (opts.didFullScan || !opts.api || !opts.rootDirId) return false;
  p?.beginPhase('hydrateLocalOnlyFromParents');
  const { merged, blocked } = await hydrateLocalOnlyFromParents({
    api: opts.api,
    meta: opts.meta,
    cloudSnap: opts.cloudSnap,
    localSnap,
    rootDirId: opts.rootDirId,
  });
  if (blocked > 0) {
    logger.warn(
      `hydrate: ${blocked} unverified local-only path(s) — falling back to full cloud scan`,
    );
    const n = await replaceCloudSnapFromLiveScan({
      api: opts.api,
      meta: opts.meta,
      cloudSnap: opts.cloudSnap,
      rootDirId: opts.rootDirId,
      syncInclude: opts.syncInclude,
      syncExclude: opts.syncExclude,
    });
    p?.endPhase(`${merged} linked, ${blocked} blocked → full scan ${n}`);
    return true;
  }
  p?.endPhase(`${merged} linked`);
  return false;
}
