/**
 * Metadata calibration: fill missing metadata for files present on both sides.
 *
 * Matches Python decision.py:calibrate_metadata — treats both-side files
 * with no metadata as "already synced" to avoid mass misclassification.
 */
import type { MetadataStore } from '../metadata/store.js';
import type { CloudFile } from '../types/scan.js';
import type { LocalFile } from '../types/scan.js';
import type { ContentHash, DirId, FileId } from '../types/common.js';
import { computeContentHashFromFile } from '../hash.js';

export function calibrateMetadata(
  meta: MetadataStore,
  cloudSnap: ReadonlyMap<string, CloudFile>,
  localSnap: ReadonlyMap<string, LocalFile>,
  localHashes: Map<string, ContentHash | null>,
): number {
  let calibrated = 0;

  meta.batch(() => {
    for (const [relPath, cloudFile] of cloudSnap) {
      if (cloudFile.isDir) {
        if (!meta.getDirId(relPath) && cloudFile.id) {
          meta.setDirInfo(relPath, cloudFile.id as DirId, cloudFile.parentId);
          calibrated++;
        }
        continue;
      }

      const local = localSnap.get(relPath);
      if (!local || local.isDir) continue;

      const existing = meta.getFileInfo(relPath);

      // Case 1: existing record has file_id but cloud_mtime=0 (migrated from JSON)
      if (existing?.fileId && existing.localMtime > 0 && existing.cloudMtime === 0 && cloudFile.mtime > 0) {
        meta.setFileInfo(relPath, {
          fileId: existing.fileId,
          cloudMtime: cloudFile.mtime,
          localMtime: existing.localMtime,
        });
        calibrated++;
        if (existing.contentHash || existing.lastSyncAt > 0) continue;
        // Fall through to full calibration for incomplete records
      } else if (existing?.contentHash || (existing && existing.lastSyncAt > 0)) {
        continue;
      }

      // Case 2: no metadata or incomplete → establish baseline
      let hash = localHashes.get(relPath) ?? null;
      if (!hash) {
        hash = computeContentHashFromFile(local.path);
        if (hash) localHashes.set(relPath, hash);
      }
      if (!hash) continue;

      meta.setFileInfo(relPath, {
        fileId: cloudFile.id as FileId,
        cloudMtime: cloudFile.mtime,
        localMtime: local.mtime,
        parentId: cloudFile.parentId,
        domain: cloudFile.domain,
        contentHash: hash,
        createTime: cloudFile.ctime || 0,
      });
      meta.markSynced(relPath);
      calibrated++;
    }
  });

  return calibrated;
}
