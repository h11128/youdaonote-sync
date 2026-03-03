import type { ContentHash, DirId, FileId, NoteDomain } from './common.js';

export interface MetadataRecord {
  readonly fileId: FileId;
  readonly cloudMtime: number;
  readonly localMtime: number;
  readonly contentHash: ContentHash | null;
  readonly cloudContentHash: ContentHash | null;
  readonly parentId: DirId | null;
  readonly domain: NoteDomain;
  readonly lastSyncAt: number;
  readonly originalDomain: NoteDomain | null;
  readonly createTime: number;
}
