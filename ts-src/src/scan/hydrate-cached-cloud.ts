/**
 * When the cloud snap came from metadata cache, local-only paths are not
 * "cloud absent" — the index never listed that folder. List each parent
 * with the same mapping as a full scan, then merge only those paths.
 */
import { posix } from 'node:path';
import type { DirId, RelPath } from '../types/common.js';
import { asDirId, asFileId, asRelPath } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { MetadataStore } from '../metadata/store.js';
import type { DirBrowser } from './cloud.js';
import { collectDirEntries } from './cloud.js';
import { pickPreferredCloud } from './cloud-identity.js';
import { logger } from '../util/logger.js';

export interface HydrateCachedCloudOpts {
  api: DirBrowser;
  meta: MetadataStore;
  cloudSnap: Map<RelPath, CloudFile>;
  localSnap: ReadonlyMap<RelPath, LocalFile>;
  rootDirId: DirId;
}

export interface HydrateResult {
  merged: number;
  /** Local-only files we could not verify against a live parent listing. */
  blocked: number;
}

function parentRel(relPath: RelPath): RelPath | '' {
  const norm = relPath.replace(/\\/g, '/');
  const dir = posix.dirname(norm);
  return dir === '.' ? '' : asRelPath(dir);
}

function inferDirId(
  meta: MetadataStore,
  cloudSnap: Map<RelPath, CloudFile>,
  parent: RelPath | '',
  rootDirId: DirId,
): DirId | null {
  if (!parent) return rootDirId;
  const cached = meta.getDirId(parent);
  if (cached) return cached;
  const asDir = cloudSnap.get(parent);
  if (asDir?.isDir && asDir.id) return asDirId(String(asDir.id));
  for (const [rel, cf] of cloudSnap) {
    if (!cf.isDir && parentRel(rel) === parent && cf.parentId) return cf.parentId;
  }
  return null;
}

function listingMatchesParent(
  entries: [RelPath, CloudFile][],
  parent: RelPath | '',
  cloudSnap: Map<RelPath, CloudFile>,
): boolean {
  const expected = [...cloudSnap].filter(([rel, cf]) => !cf.isDir && parentRel(rel) === parent);
  if (expected.length === 0) return true;
  const listedIds = new Set(entries.map(([, cf]) => String(cf.id)));
  return expected.some(([, cf]) => listedIds.has(String(cf.id)));
}

function localOnlyPaths(
  localSnap: ReadonlyMap<RelPath, LocalFile>,
  cloudSnap: Map<RelPath, CloudFile>,
): RelPath[] {
  const out: RelPath[] = [];
  for (const [rel, local] of localSnap) {
    if (!local.isDir && !cloudSnap.has(rel)) out.push(rel);
  }
  return out;
}

function mergeWanted(
  entries: [RelPath, CloudFile][],
  wanted: ReadonlySet<RelPath>,
  cloudSnap: Map<RelPath, CloudFile>,
  meta: MetadataStore,
): number {
  let merged = 0;
  for (const [rel, cloud] of entries) {
    if (cloud.isDir || !wanted.has(rel)) continue;
    const prev = cloudSnap.get(rel);
    const next = pickPreferredCloud(prev, cloud);
    cloudSnap.set(rel, next);
    if (prev?.id === next.id && prev.name === next.name) continue;
    meta.cacheCloudFileInfo(rel, {
      fileId: asFileId(String(next.id)),
      cloudMtime: next.mtime,
      parentId: next.parentId,
      domain: next.domain,
      createTime: next.ctime,
    });
    merged++;
  }
  return merged;
}

export async function hydrateLocalOnlyFromParents(
  opts: HydrateCachedCloudOpts,
): Promise<HydrateResult> {
  const { api, meta, cloudSnap, localSnap, rootDirId } = opts;
  const wantedList = localOnlyPaths(localSnap, cloudSnap);
  if (wantedList.length === 0) return { merged: 0, blocked: 0 };

  const byDir = new Map<string, { base: RelPath | ''; wanted: Set<RelPath> }>();
  let blocked = 0;
  for (const rel of wantedList) {
    const parent = parentRel(rel);
    const dirId = inferDirId(meta, cloudSnap, parent, rootDirId);
    if (!dirId) {
      logger.warn(`hydrate: no parent dir id for "${rel}" — cannot confirm cloud membership`);
      blocked++;
      continue;
    }
    const bucket = byDir.get(dirId) ?? { base: parent, wanted: new Set<RelPath>() };
    bucket.wanted.add(rel);
    byDir.set(dirId, bucket);
  }

  let merged = 0;
  for (const [dirId, { base, wanted }] of byDir) {
    let listed: Awaited<ReturnType<DirBrowser['getDirInfoById']>>;
    try {
      listed = await api.getDirInfoById(dirId as DirId);
    } catch (e: unknown) {
      logger.warn(
        `hydrate: failed to list dir ${dirId} at "${base}": ${e instanceof Error ? e.message : String(e)}`,
      );
      blocked += wanted.size;
      continue;
    }
    const { entries } = collectDirEntries(listed.entries, dirId as DirId, base);
    if (!listingMatchesParent(entries, base, cloudSnap)) {
      logger.warn(
        `hydrate: listing for "${base}" missed known siblings — treating dir id as stale`,
      );
      blocked += wanted.size;
      continue;
    }
    merged += mergeWanted(entries, wanted, cloudSnap, meta);
  }
  return { merged, blocked };
}
