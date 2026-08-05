/**
 * Local scan + calibrate + hash warmup — extracted from SyncEngine.
 */
import type { ContentHash, RelPath } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { MetadataStore } from '../metadata/store.js';
import { scanLocalParallel } from '../scan/local.js';
import { calibrateMetadata } from '../classify/calibrate.js';
import { computeHashesConcurrent } from '../algo/hash.js';
import type { HashFileEntry } from '../algo/hash.js';
import type { SyncProfiler } from '../perf/profiler.js';

export interface LocalScanPhaseOpts {
  meta: MetadataStore;
  localDir: string;
  cloudSnap: Map<RelPath, CloudFile>;
  syncInclude?: string[] | undefined;
  syncExclude?: string[] | undefined;
  profiler?: SyncProfiler | undefined;
}

export async function runLocalScanPhase(opts: LocalScanPhaseOpts): Promise<{
  localSnap: Map<RelPath, LocalFile>;
  localHashes: Map<RelPath, ContentHash | null>;
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

  p?.beginPhase('calibrateMetadata');
  const calibrated = calibrateMetadata(opts.meta, opts.cloudSnap, localSnap, localHashes);
  p?.endPhase(`${calibrated} calibrated`);

  return { localSnap, localHashes };
}
