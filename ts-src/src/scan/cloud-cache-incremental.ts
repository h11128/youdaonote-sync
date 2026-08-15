/**
 * Apply listRecent deltas onto a cached cloud snap + metadata.
 */
import {
  asEpochSeconds,
  asRelPath,
  joinRelPath,
  NoteDomain,
  type DirId,
  type FileId,
  type RelPath,
} from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import type { MetadataStore } from '../metadata/store.js';
import { mapCloudName, sanitizeFilename } from './name.js';
import { pickPreferredCloud } from './cloud-identity.js';

export function toNum(val: unknown, fallback: number): number {
  const n = Number(val);
  return Number.isNaN(n) ? fallback : n;
}

function toStr(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return '';
}

function resolveNewPath(meta: MetadataStore, parentId: string, name: string): RelPath | null {
  if (!parentId) return null;
  const parentPath = meta.findByDirId(parentId as DirId);
  if (parentPath == null) return null;
  return parentPath ? joinRelPath(asRelPath(parentPath), name) : asRelPath(name);
}

interface DirEntryParams {
  meta: MetadataStore;
  cloudFiles: Map<RelPath, CloudFile>;
  fid: string;
  name: string;
  parentId: string;
}

function processDirEntry(opts: DirEntryParams): void {
  const { meta, cloudFiles, fid, name, parentId } = opts;
  const existingPath = meta.findByDirId(fid as DirId);
  const relPath =
    (existingPath != null ? asRelPath(existingPath) : null) ??
    resolveNewPath(meta, parentId, sanitizeFilename(name));
  if (!relPath) return;

  cloudFiles.set(relPath, {
    id: fid as DirId,
    parentId: parentId as DirId,
    name,
    isDir: true,
    mtime: asEpochSeconds(0),
    ctime: asEpochSeconds(0),
    domain: NoteDomain.NOTE,
  });
  meta.setDirInfo(relPath, fid as DirId, parentId as DirId);
}

interface FileEntryParams extends DirEntryParams {
  fe: Record<string, unknown>;
}

function processFileEntry(opts: FileEntryParams): void {
  const { meta, cloudFiles, fe, fid, name, parentId } = opts;
  const mtime = toNum(fe.modifyTimeForSort, 0);
  const ctime = toNum(fe.createTimeForSort, 0);
  const domain = toNum(fe.domain, 0) as NoteDomain;
  const existingPath = meta.findByFileId(fid as FileId);
  const relPath =
    (existingPath != null ? asRelPath(existingPath) : null) ??
    resolveNewPath(meta, parentId, mapCloudName(name));
  if (!relPath) return;

  const info: CloudFile = {
    id: fid as FileId,
    parentId: parentId as DirId,
    name,
    isDir: false,
    mtime: asEpochSeconds(mtime),
    ctime: asEpochSeconds(ctime),
    domain,
  };
  const chosen = pickPreferredCloud(cloudFiles.get(relPath), info);
  cloudFiles.set(relPath, chosen);
  meta.cacheCloudFileInfo(relPath, {
    fileId: chosen.id as FileId,
    cloudMtime: chosen.mtime,
    parentId: chosen.parentId,
    domain: chosen.domain,
    createTime: chosen.ctime,
  });
}

export function applyIncrementalChanges(
  meta: MetadataStore,
  cloudFiles: Map<RelPath, CloudFile>,
  changedEntries: Record<string, unknown>[],
): void {
  meta.batch(() => {
    for (const entry of changedEntries) {
      const fe = entry.fileEntry as Record<string, unknown> | undefined;
      if (!fe) continue;
      const fid = toStr(fe.id);
      const name = toStr(fe.name);
      if (!fid || !name) continue;

      const isDir = Boolean(fe.dir);
      const parentId = toStr(fe.parentId);

      if (isDir) {
        processDirEntry({ meta, cloudFiles, fid, name, parentId });
      } else {
        processFileEntry({ meta, cloudFiles, fe, fid, name, parentId });
      }
    }
  });
}
