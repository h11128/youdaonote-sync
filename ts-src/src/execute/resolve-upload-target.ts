import type { FileId, NoteDomain } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { UploadFileOpts } from './upload.js';

export interface UploadTarget {
  fileId?: FileId;
  domain?: NoteDomain;
  name?: string;
}

function nonemptyId(id: string | undefined): FileId | undefined {
  if (!id) return undefined;
  return id as FileId;
}

function scannedFile(cloudFile: CloudFile | undefined): CloudFile | undefined {
  if (!cloudFile || cloudFile.isDir) return undefined;
  return cloudFile;
}

/**
 * Bind an upload to the cloud file already mapped onto this local path.
 * Scanned cloud id/name/domain win over metadata (empty or stale file_id).
 * Metadata id is only used when this sync's cloud snapshot has no file.
 */
export function resolveUploadMeta(
  record: { fileId?: FileId; domain?: NoteDomain } | undefined,
  cloudFile: CloudFile | undefined,
): UploadTarget | undefined {
  const scanned = scannedFile(cloudFile);
  const fileId = nonemptyId(scanned ? String(scanned.id) : undefined) ?? nonemptyId(record?.fileId);
  const domain = scanned?.domain ?? record?.domain;
  const name = scanned?.name;
  if (fileId == null && domain == null && name == null) return undefined;
  const out: UploadTarget = {};
  if (fileId != null) out.fileId = fileId;
  if (domain != null) out.domain = domain;
  if (name != null) out.name = name;
  return out;
}

export function applyUploadTarget(ulOpts: UploadFileOpts, target: UploadTarget): void {
  if (target.fileId) ulOpts.existingFileId = target.fileId;
  if (target.domain != null) ulOpts.existingDomain = target.domain;
  if (target.name) ulOpts.existingName = target.name;
}

export function applyCloudUploadTarget(ulOpts: UploadFileOpts, cloudFile: CloudFile): void {
  applyUploadTarget(ulOpts, {
    fileId: cloudFile.id as FileId,
    domain: cloudFile.domain,
    name: cloudFile.name,
  });
}
