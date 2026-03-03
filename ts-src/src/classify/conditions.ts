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

export function extractConditions(input: ClassifyInput): Conditions {
  const { local, cloud, meta, localHash } = input;

  let localHashChanged: boolean | null = null;
  if (localHash && meta?.contentHash) {
    localHashChanged = localHash !== meta.contentHash;
  }

  // Python: cloud_mtime > meta_cloud_mtime (strictly greater, not just different)
  let cloudMtimeChanged: boolean | null = null;
  if (cloud && meta && meta.cloudMtime > 0) {
    cloudMtimeChanged = cloud.mtime > meta.cloudMtime;
  } else if (cloud && meta && meta.cloudMtime === 0) {
    cloudMtimeChanged = true;
  }

  // Python: meta_local_mtime is None → local_changed = True
  let localMtimeChanged: boolean | null = null;
  if (local && meta && meta.localMtime > 0) {
    localMtimeChanged = local.mtime > meta.localMtime;
  } else if (local && meta) {
    localMtimeChanged = true;
  }

  return {
    localExists: local !== null,
    cloudExists: cloud !== null,
    previouslySynced: meta !== null && !!meta.fileId && meta.lastSyncAt > 0,
    localHashChanged,
    cloudMtimeChanged,
    localMtimeChanged,
  };
}
