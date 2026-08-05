/**
 * Classify → moves → orphan discard → conflict refine.
 * Extracted from SyncEngine for the 300-line budget.
 */
import type { ContentHash, RelPath } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { FileState, SyncLogMetadata } from '../types/state.js';
import type { YoudaoNoteApi } from '../api/client.js';
import type { MetadataStore } from '../metadata/store.js';
import { classifyAll } from '../classify/classify.js';
import { detectMoves } from '../classify/moves.js';
import { resolvePrimaryMoveHash } from '../classify/move-hashes.js';
import { discardOrphanDuplicates } from '../dedup/index.js';
import { computeContentHashFromBytes } from '../algo/hash.js';
import { filterMapByExclude, markExcludedAsGone } from './helpers.js';
import { refineAllConflicts } from './refine.js';
import type { SyncProfiler } from '../perf/profiler.js';

export interface ClassifyPhaseOpts {
  api: YoudaoNoteApi;
  meta: MetadataStore;
  cloudSnap: Map<RelPath, CloudFile>;
  localSnap: Map<RelPath, LocalFile>;
  localHashes: Map<RelPath, ContentHash | null>;
  syncInclude?: string[] | undefined;
  syncExclude?: string[] | undefined;
  hashFn?: ((data: Uint8Array, path: string) => ContentHash | null) | undefined;
  profiler?: SyncProfiler | undefined;
}

interface MoveDetectionOpts {
  classified: Map<RelPath, FileState>;
  localHashes: Map<RelPath, ContentHash | null>;
  metaSnap: ReadonlyMap<
    RelPath,
    { contentHash?: ContentHash | null; cloudContentHash?: ContentHash | null }
  >;
  cloudSnap: Map<RelPath, CloudFile>;
  meta: MetadataStore;
}

function applyMoveDetection(o: MoveDetectionOpts): number {
  const classifiedWithHash = new Map<RelPath, { state: FileState; hash: ContentHash | null }>();
  for (const [path, state] of o.classified) {
    const rec = o.metaSnap.get(path);
    const hash = resolvePrimaryMoveHash(
      o.localHashes.get(path),
      rec?.contentHash,
      rec?.cloudContentHash,
    );
    classifiedWithHash.set(path, { state, hash });
  }
  let count = 0;
  for (const [path, movedState] of detectMoves(classifiedWithHash, o.meta, o.cloudSnap)) {
    o.classified.set(path, movedState);
    count++;
  }
  return count;
}

function discardOrphans(
  classified: Map<RelPath, FileState>,
  cloudSnap: Map<RelPath, CloudFile>,
  localSnap: Map<RelPath, LocalFile>,
  localHashes: Map<RelPath, ContentHash | null>,
): number {
  let orphanCount = 0;
  for (const orphanPath of discardOrphanDuplicates(cloudSnap, localSnap, localHashes)) {
    classified.set(orphanPath, { kind: 'gone' });
    orphanCount++;
  }
  return orphanCount;
}

export async function runClassifyAndRefine(opts: ClassifyPhaseOpts): Promise<{
  classified: Map<RelPath, FileState>;
  metadata: Map<RelPath, SyncLogMetadata>;
}> {
  const p = opts.profiler;
  p?.beginPhase('classifyAll');
  const pathFilters = {
    ...(opts.syncInclude !== undefined ? { include: opts.syncInclude } : {}),
    ...(opts.syncExclude !== undefined ? { exclude: opts.syncExclude } : {}),
  };
  const metaSnap = filterMapByExclude(opts.meta.getAllFiles(), pathFilters);
  const { classified, metadata } = classifyAll(
    opts.cloudSnap,
    opts.localSnap,
    metaSnap,
    opts.localHashes,
  );
  markExcludedAsGone(classified, pathFilters);
  p?.endPhase(`${classified.size} entries`);

  p?.beginPhase('detectMoves');
  const moveCount = applyMoveDetection({
    classified,
    localHashes: opts.localHashes,
    metaSnap,
    cloudSnap: opts.cloudSnap,
    meta: opts.meta,
  });
  p?.endPhase(`${moveCount} moves`);

  p?.beginPhase('discardOrphanDuplicates');
  const orphanCount = discardOrphans(classified, opts.cloudSnap, opts.localSnap, opts.localHashes);
  p?.endPhase(`${orphanCount} discarded`);

  p?.beginPhase('refineAllConflicts');
  await refineAllConflicts({
    classified,
    cloudSnap: opts.cloudSnap,
    localHashes: opts.localHashes,
    hashFn: opts.hashFn ?? computeContentHashFromBytes,
    meta: opts.meta,
    api: opts.api,
  });
  p?.endPhase();

  return { classified, metadata };
}
