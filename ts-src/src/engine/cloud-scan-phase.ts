/**
 * Cloud scan + filter + version save — extracted from SyncEngine (line budget).
 */
import type { DirId, RelPath } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { MetadataStore } from '../metadata/store.js';
import type { YoudaoNoteApi } from '../api/client.js';
import { scanCloud, type DirBrowser } from '../scan/cloud.js';
import { tryCachedCloudScan, saveScanVersion, fetchCurrentVersion } from '../scan/cloud-cache.js';
import { filterCloudSnap } from './helpers.js';
import type { SyncProfiler } from '../perf/profiler.js';

export type LiveScanApi = DirBrowser & {
  listRecent?: (limit: number) => Promise<Record<string, unknown>[]>;
};

/** Empty or collapsed live listing must not replace a larger cache. */
export function isUsableLiveCloudSnap(
  live: ReadonlyMap<RelPath, CloudFile>,
  priorSize: number,
): boolean {
  if (live.size === 0) return false;
  return priorSize === 0 || live.size * 2 >= priorSize;
}

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

  const cloudSnap = await scanCloud(opts.api, opts.rootDirId, { failOnDirError: true });
  p?.endPhase(`${cloudSnap.size} entries (full)`);
  // Filter BEFORE saveScanVersion so excluded paths never re-enter metadata.
  p?.beginPhase('filterCloudSnap');
  applyCloudFilters(cloudSnap, filterOpts);
  p?.endPhase(`→ ${cloudSnap.size} after filter`);
  saveScanVersion(opts.meta, cloudSnap, await fetchCurrentVersion(opts.api));
  return { cloudSnap, didFullScan: true };
}

export async function replaceCloudSnapFromLiveScan(opts: {
  api: LiveScanApi;
  meta: MetadataStore;
  cloudSnap: Map<RelPath, CloudFile>;
  rootDirId: DirId;
  syncInclude?: string[] | undefined;
  syncExclude?: string[] | undefined;
}): Promise<number> {
  const priorSize = opts.cloudSnap.size;
  const live = await scanCloud(opts.api, opts.rootDirId, { failOnDirError: true });
  if (!isUsableLiveCloudSnap(live, priorSize)) {
    throw new Error(`full-scan fallback refused: live ${live.size} files vs cache ${priorSize}`);
  }
  const next = new Map(live);
  const filterOpts: { include?: string[]; exclude?: string[] } = {};
  if (opts.syncInclude) filterOpts.include = opts.syncInclude;
  if (opts.syncExclude) filterOpts.exclude = opts.syncExclude;
  applyCloudFilters(next, filterOpts);
  if (next.size === 0 && priorSize > 0 && !filterOpts.include && !filterOpts.exclude) {
    throw new Error(`full-scan fallback refused: filtered live empty vs cache ${priorSize}`);
  }
  opts.cloudSnap.clear();
  for (const [rel, cloud] of next) opts.cloudSnap.set(rel, cloud);
  const listRecent = opts.api.listRecent;
  const version = listRecent ? await fetchCurrentVersion({ listRecent }) : 0;
  saveScanVersion(opts.meta, opts.cloudSnap, version);
  return opts.cloudSnap.size;
}
