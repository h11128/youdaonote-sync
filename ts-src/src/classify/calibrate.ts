/**
 * Metadata calibration: fill missing metadata for files present on both sides.
 *
 * Matches Python decision.py:calibrate_metadata — treats both-side files
 * with no metadata as "already synced" to avoid mass misclassification.
 */
import type { MetadataStore } from '../metadata/store.js';
import type { CloudFile } from '../types/scan.js';
import type { LocalFile } from '../types/scan.js';
import {
  asEpochSeconds,
  type ContentHash,
  type DirId,
  type FileId,
  type RelPath,
} from '../types/common.js';
import type { MetadataRecord } from '../types/metadata.js';
import { computeContentHashFromFile } from '../algo/hash.js';

function calibrateDir(meta: MetadataStore, relPath: RelPath, cloudFile: CloudFile): boolean {
  if (meta.getDirId(relPath) || !cloudFile.id) return false;
  meta.setDirInfo(relPath, cloudFile.id as DirId, cloudFile.parentId);
  return true;
}

function calibrateFileCase1(
  meta: MetadataStore,
  relPath: RelPath,
  cloudFile: CloudFile,
  existing: MetadataRecord,
): boolean {
  if (
    !existing.fileId ||
    existing.localMtime <= 0 ||
    existing.cloudMtime !== 0 ||
    cloudFile.mtime <= 0
  ) {
    return false;
  }
  meta.setFileInfo(relPath, {
    fileId: existing.fileId,
    cloudMtime: cloudFile.mtime,
    localMtime: existing.localMtime,
  });
  return true;
}

function shouldSkipCalibration(existing: MetadataRecord | undefined): boolean {
  if (!existing) return false;
  return (existing.contentHash ?? null) !== null || existing.lastSyncAt > 0;
}

interface CalibrateFileCase2Opts {
  meta: MetadataStore;
  relPath: RelPath;
  cloudFile: CloudFile;
  local: LocalFile;
  localHashes: Map<RelPath, ContentHash | null>;
}

function calibrateFileCase2(opts: CalibrateFileCase2Opts): boolean {
  const { meta, relPath, cloudFile, local, localHashes } = opts;
  let hash = localHashes.get(relPath) ?? null;
  if (!hash) {
    hash = computeContentHashFromFile(local.path);
    if (hash) localHashes.set(relPath, hash);
  }
  if (!hash) return false;

  meta.setFileInfo(relPath, {
    fileId: cloudFile.id as FileId,
    cloudMtime: cloudFile.mtime,
    localMtime: local.mtime,
    parentId: cloudFile.parentId,
    domain: cloudFile.domain,
    contentHash: hash,
    createTime: asEpochSeconds(cloudFile.ctime || 0),
  });
  meta.markSynced(relPath);
  return true;
}

interface ProcessFileOpts {
  meta: MetadataStore;
  relPath: RelPath;
  cloudFile: CloudFile;
  localSnap: ReadonlyMap<RelPath, LocalFile>;
  localHashes: Map<RelPath, ContentHash | null>;
}

function processFile(opts: ProcessFileOpts): number {
  const { meta, relPath, cloudFile, localSnap, localHashes } = opts;
  const local = localSnap.get(relPath);
  if (!local || local.isDir) return 0;

  const existing = meta.getFileInfo(relPath);

  if (existing && calibrateFileCase1(meta, relPath, cloudFile, existing)) {
    if ((existing.contentHash ?? null) !== null || existing.lastSyncAt > 0) {
      return 1;
    }
    if (calibrateFileCase2({ meta, relPath, cloudFile, local, localHashes })) {
      return 2;
    }
    return 1;
  }
  if (shouldSkipCalibration(existing ?? undefined)) return 0;
  return calibrateFileCase2({ meta, relPath, cloudFile, local, localHashes }) ? 1 : 0;
}

export function calibrateMetadata(
  meta: MetadataStore,
  cloudSnap: ReadonlyMap<RelPath, CloudFile>,
  localSnap: ReadonlyMap<RelPath, LocalFile>,
  localHashes: Map<RelPath, ContentHash | null>,
): number {
  let calibrated = 0;

  meta.batch(() => {
    for (const [relPath, cloudFile] of cloudSnap) {
      if (cloudFile.isDir) {
        if (calibrateDir(meta, relPath, cloudFile)) calibrated++;
      } else {
        calibrated += processFile({
          meta,
          relPath,
          cloudFile,
          localSnap,
          localHashes,
        });
      }
    }
  });

  return calibrated;
}
