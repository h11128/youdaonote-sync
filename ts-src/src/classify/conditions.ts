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
  return {
    localExists: local !== null,
    cloudExists: cloud !== null,
    previouslySynced: meta !== null && meta.lastSyncAt > 0,
    localHashChanged:
      localHash && meta?.contentHash
        ? localHash !== meta.contentHash
        : null,
    cloudMtimeChanged:
      cloud && meta
        ? cloud.mtime !== meta.cloudMtime
        : null,
    localMtimeChanged:
      local && meta && meta.localMtime > 0
        ? local.mtime > meta.localMtime
        : null,
  };
}
