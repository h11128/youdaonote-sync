import type { ContentHash } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { MetadataRecord } from '../types/metadata.js';

export interface ClassifyInput {
  readonly local: LocalFile | null;
  readonly cloud: CloudFile | null;
  readonly meta: MetadataRecord | null;
  readonly localHash: ContentHash | null;
}

export interface Conditions {
  readonly localExists: boolean;
  readonly cloudExists: boolean;
  readonly previouslySynced: boolean;
  readonly localHashChanged: boolean | null;
  readonly cloudMtimeChanged: boolean | null;
  readonly localMtimeChanged: boolean | null;
}

function computeLocalHashChanged(
  localHash: ContentHash | null,
  meta: MetadataRecord | null,
): boolean | null {
  if (!localHash || !meta?.contentHash) return null;
  return localHash !== meta.contentHash;
}

function computeCloudMtimeChanged(
  cloud: CloudFile | null,
  meta: MetadataRecord | null,
): boolean | null {
  if (!cloud || !meta) return null;
  // A row that was never synced has no verified cloud baseline: cacheCloudFileInfo
  // stamps file_id + cloud_mtime straight off a cloud listing whose content we have
  // never held. Reporting "unchanged" there would let classify treat cloud content
  // it has never seen as already-in-sync and blind-push over it.
  if (meta.lastSyncAt <= 0) return null;
  if (meta.cloudMtime > 0) return cloud.mtime > meta.cloudMtime;
  if (meta.cloudMtime === 0) return true;
  return null;
}

function computeLocalMtimeChanged(
  local: LocalFile | null,
  meta: MetadataRecord | null,
): boolean | null {
  if (!local || !meta) return null;
  if (meta.localMtime > 0) return local.mtime > meta.localMtime;
  return true;
}

export function extractConditions(input: ClassifyInput): Conditions {
  const { local, cloud, meta, localHash } = input;

  return {
    localExists: local !== null,
    cloudExists: cloud !== null,
    previouslySynced: meta !== null && !!meta.fileId && meta.lastSyncAt > 0,
    localHashChanged: computeLocalHashChanged(localHash, meta),
    cloudMtimeChanged: computeCloudMtimeChanged(cloud, meta),
    localMtimeChanged: computeLocalMtimeChanged(local, meta),
  };
}
