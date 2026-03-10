import { asEpochSeconds, type DirId, type FileId, type NoteDomain } from '../types/common.js';
import type { DirInfoByIdResponse } from '../types/dir.js';
import type { CloudFile } from '../types/scan.js';
import { mapCloudName } from './name.js';
import { retryWithBackoff } from '../api/retry.js';

/**
 * Interface for the directory listing API.
 * Matches the subset of YoudaoNoteApi needed for cloud scanning.
 */
export interface DirBrowser {
  getDirInfoById(dirId: DirId): Promise<DirInfoByIdResponse>;
}

/**
 * BFS scan of cloud directory tree.
 *
 * Returns Map<relativePath, CloudFile> where relativePath uses
 * mapCloudName for filename mapping (.note → .md, character sanitization).
 *
 * Uses concurrent fetching with a configurable worker count.
 */
interface QueueItem {
  dirId: DirId;
  basePath: string;
}

export interface ScanCloudOpts {
  base?: string;
  maxConcurrent?: number;
  retryOpts?: { maxRetries?: number; baseDelay?: number };
}

function normalizeOpts(optsOrBase?: ScanCloudOpts | string, maxConcurrent?: number): ScanCloudOpts {
  if (typeof optsOrBase === 'string') {
    return { base: optsOrBase, ...(maxConcurrent != null ? { maxConcurrent } : {}) };
  }
  return optsOrBase ?? {};
}

export async function scanCloud(
  api: DirBrowser,
  rootDirId: DirId,
  optsOrBase?: ScanCloudOpts | string,
  maxConcurrent?: number,
): Promise<Map<string, CloudFile>> {
  if (!rootDirId) throw new Error('rootDirId must not be empty');
  const opts = normalizeOpts(optsOrBase, maxConcurrent);
  return bfsScan(api, rootDirId, opts);
}

async function bfsScan(
  api: DirBrowser,
  rootDirId: DirId,
  opts: ScanCloudOpts,
): Promise<Map<string, CloudFile>> {
  const concurrency = opts.maxConcurrent ?? 8;
  const files = new Map<string, CloudFile>();
  const visited = new Set<string>([rootDirId]);
  const queue: QueueItem[] = [{ dirId: rootDirId, basePath: opts.base ?? '' }];
  let inflight = 0;
  let resolveAll: (() => void) | null = null;

  async function processItem(item: QueueItem): Promise<void> {
    try {
      const { entries, subdirs } = await fetchDir(api, item.dirId, item.basePath, opts.retryOpts);
      for (const [rel, cloud] of entries) files.set(rel, cloud);
      for (const sub of subdirs) {
        if (!visited.has(sub.dirId)) {
          visited.add(sub.dirId);
          queue.push(sub);
        }
      }
    } finally {
      inflight--;
      drain();
    }
  }

  function drain(): void {
    while (queue.length > 0 && inflight < concurrency) {
      const item = queue.shift();
      if (item == null) break;
      inflight++;
      void processItem(item);
    }
    if (inflight === 0 && queue.length === 0 && resolveAll) resolveAll();
  }

  await new Promise<void>((resolve) => {
    resolveAll = resolve;
    drain();
    if (inflight === 0 && queue.length === 0) resolve();
  });
  return files;
}

function buildRelPath(basePath: string, name: string): string {
  return basePath ? `${basePath}/${name}` : name;
}

function parseEntry(
  fe: {
    id: string;
    name: string;
    dir?: boolean;
    modifyTimeForSort?: number;
    createTimeForSort?: number;
    domain?: number;
  },
  dirId: DirId,
  basePath: string,
): {
  rel: string;
  cloudFile: CloudFile;
  subdir?: { dirId: DirId; basePath: string } | undefined;
} | null {
  if (fe.name.startsWith('.')) return null;
  const isDir = fe.dir ?? false;
  const rel = buildRelPath(basePath, isDir ? fe.name : mapCloudName(fe.name));
  const cloudFile: CloudFile = {
    id: isDir ? (fe.id as DirId) : (fe.id as FileId),
    parentId: dirId,
    name: fe.name,
    isDir,
    mtime: asEpochSeconds(fe.modifyTimeForSort ?? 0),
    ctime: asEpochSeconds(fe.createTimeForSort ?? 0),
    domain: (fe.domain ?? 1) as NoteDomain,
  };
  const subdir = isDir
    ? { dirId: fe.id as DirId, basePath: buildRelPath(basePath, fe.name) }
    : undefined;
  return { rel, cloudFile, subdir };
}

async function fetchDir(
  api: DirBrowser,
  dirId: DirId,
  basePath: string,
  retryOpts?: { maxRetries?: number; baseDelay?: number },
): Promise<{
  entries: [string, CloudFile][];
  subdirs: { dirId: DirId; basePath: string }[];
}> {
  let data: Awaited<ReturnType<DirBrowser['getDirInfoById']>>;
  try {
    data = await retryWithBackoff(() => api.getDirInfoById(dirId), retryOpts);
  } catch (e: unknown) {
    console.warn(
      `Cloud scan: failed to list dir ${dirId} at "${basePath}": ${e instanceof Error ? e.message : String(e)}`,
    );
    return { entries: [], subdirs: [] };
  }

  const entries: [string, CloudFile][] = [];
  const subdirs: { dirId: DirId; basePath: string }[] = [];
  for (const entry of data.entries ?? []) {
    const parsed = parseEntry(entry.fileEntry, dirId, basePath);
    if (!parsed) continue;
    entries.push([parsed.rel, parsed.cloudFile]);
    if (parsed.subdir) subdirs.push(parsed.subdir);
  }
  return { entries, subdirs };
}
