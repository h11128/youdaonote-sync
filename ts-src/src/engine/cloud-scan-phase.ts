/**
 * Cloud scan + filter + version save — extracted from SyncEngine (line budget).
 */
import type { DirId, RelPath } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { MetadataStore } from '../metadata/store.js';
import type { YoudaoNoteApi } from '../api/client.js';
import { scanCloud } from '../scan/cloud.js';
import { tryCachedCloudScan, saveScanVersion, fetchCurrentVersion } from '../scan/cloud-cache.js';
import { filterCloudSnap } from './helpers.js';
import type { SyncProfiler } from '../perf/profiler.js';

export interface CloudScanPhaseOpts {
  api: YoudaoNoteApi;
  meta: MetadataStore;
  rootDirId: DirId;
  /** Skip desktop seed when tests inject an API mock. */
  skipDesktopSeed: boolean;
  dryRun: boolean;
  syncInclude?: string[] | undefined;
  syncExclude?: string[] | undefined;
  profiler?: SyncProfiler | undefined;
}

function applyCloudFilters(
  cloudSnap: Map<RelPath, CloudFile>,
  opts: { include?: string[]; exclude?: string[] },
): void {
  if (opts.include?.length || opts.exclude?.length) {
    filterCloudSnap(cloudSnap, opts);
  }
  for (const [path] of [...cloudSnap]) {
    if ((path.split('/').pop() ?? '').includes('.conflict.')) cloudSnap.delete(path);
  }
}

export async function runCloudScanPhase(
  opts: CloudScanPhaseOpts,
): Promise<{ cloudSnap: Map<RelPath, CloudFile>; didFullScan: boolean }> {
  const p = opts.profiler;
  p?.beginPhase('cloudScan');
  const cached = await tryCachedCloudScan({
    api: opts.api,
    meta: opts.meta,
    skipDesktopSeed: opts.skipDesktopSeed,
    cacheTtlSeconds: opts.dryRun ? 0 : undefined,
  });

  const filterOpts: { include?: string[]; exclude?: string[] } = {};
  if (opts.syncInclude) filterOpts.include = opts.syncInclude;
  if (opts.syncExclude) filterOpts.exclude = opts.syncExclude;

  if (cached) {
    const cloudSnap = cached;
    p?.endPhase(`${cloudSnap.size} entries (cached)`);
    p?.beginPhase('filterCloudSnap');
    applyCloudFilters(cloudSnap, filterOpts);
    p?.endPhase(`→ ${cloudSnap.size} after filter`);
    return { cloudSnap, didFullScan: false };
  }

  const cloudSnap = await scanCloud(opts.api, opts.rootDirId);
  p?.endPhase(`${cloudSnap.size} entries (full)`);
  // Filter BEFORE saveScanVersion so excluded paths never re-enter metadata.
  p?.beginPhase('filterCloudSnap');
  applyCloudFilters(cloudSnap, filterOpts);
  p?.endPhase(`→ ${cloudSnap.size} after filter`);
  saveScanVersion(opts.meta, cloudSnap, await fetchCurrentVersion(opts.api));
  return { cloudSnap, didFullScan: true };
}
