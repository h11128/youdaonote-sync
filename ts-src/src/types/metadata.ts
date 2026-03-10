import type { ContentHash, DirId, EpochSeconds, FileId, NoteDomain } from './common.js';

export interface MetadataRecord {
  readonly fileId: FileId;
  readonly cloudMtime: EpochSeconds;
  readonly localMtime: EpochSeconds;
  readonly contentHash: ContentHash | null;
  readonly cloudContentHash: ContentHash | null;
  readonly parentId: DirId | null;
  readonly domain: NoteDomain;
  readonly lastSyncAt: EpochSeconds;
  readonly originalDomain: NoteDomain | null;
  readonly createTime: EpochSeconds;
}
