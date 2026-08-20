/**
 * Heal cloud_mtime baselines against a live cloud snapshot before classify.
 */
import type { CloudFile } from '../types/scan.js';
import type { MetadataStore } from './store.js';
import type { FileId, RelPath } from '../types/common.js';
import type { MetadataRecord } from '../types/metadata.js';

export interface HealCloudMtimeStats {
  readonly fileIdRelink: number;
  readonly baselineAhead: number;
}

interface HealSyncedRowOpts {
  meta: MetadataStore;
  path: RelPath;
  record: MetadataRecord;
  cloud: CloudFile;
  autoFix: boolean;
}

function healSyncedRow(opts: HealSyncedRowOpts): { relink: boolean; ahead: boolean } {
  const { meta, path, record, cloud, autoFix } = opts;
  if (record.fileId && record.fileId !== cloud.id) {
    if (autoFix) {
      meta.setFileInfo(path, {
        fileId: cloud.id as FileId,
        cloudMtime: cloud.mtime,
        localMtime: record.localMtime,
        parentId: record.parentId,
        domain: record.domain,
        contentHash: record.contentHash,
        createTime: record.createTime,
        lastSyncAt: record.lastSyncAt,
        cloudContentHash: record.cloudContentHash,
      });
    }
    return { relink: true, ahead: false };
  }

  if (record.cloudMtime > cloud.mtime) {
    if (autoFix) meta.updateCloudMtime(path, cloud.mtime);
    return { relink: false, ahead: true };
  }

  return { relink: false, ahead: false };
}

/**
 * Repair metadata cloud_mtime rows that block classify from seeing cloud edits.
 *
 * - file_id relink: cloud listing points at a different id → refresh baseline mtime
 * - baseline ahead: meta.cloudMtime > live cloud.mtime (pre-fix scan corruption)
 */
export function healCloudMtimeBaseline(
  meta: MetadataStore,
  cloudSnap: ReadonlyMap<RelPath, CloudFile>,
  autoFix = false,
): HealCloudMtimeStats {
  let fileIdRelink = 0;
  let baselineAhead = 0;

  meta.batch(() => {
    for (const [path, record] of meta.getAllFiles()) {
      if (record.lastSyncAt <= 0) continue;
      const cloud = cloudSnap.get(path);
      if (!cloud || cloud.isDir) continue;

      const healed = healSyncedRow({ meta, path, record, cloud, autoFix });
      if (healed.relink) fileIdRelink++;
      if (healed.ahead) baselineAhead++;
    }
  });

  if (autoFix) meta.save();
  return { fileIdRelink, baselineAhead };
}
