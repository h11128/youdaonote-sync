import type { DirId, FileId, NoteDomain } from '../types/common.js';
import type { DirInfoByIdResponse } from '../types/dir.js';
import type { CloudFile } from '../types/scan.js';
import { mapCloudName } from './name.js';

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

export async function scanCloud(
  api: DirBrowser,
  rootDirId: DirId,
  base = '',
  maxConcurrent = 8,
): Promise<Map<string, CloudFile>> {
  if (!rootDirId) throw new Error('rootDirId must not be empty');

  const files = new Map<string, CloudFile>();
  const visited = new Set<string>([rootDirId]);
  const queue: QueueItem[] = [{ dirId: rootDirId, basePath: base }];
  let inflight = 0;
  let resolveAll: (() => void) | null = null;

  async function processItem(item: QueueItem): Promise<void> {
    try {
      const { entries, subdirs } = await fetchDir(api, item.dirId, item.basePath);

      for (const [rel, cloud] of entries) {
        files.set(rel, cloud);
      }
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
    while (queue.length > 0 && inflight < maxConcurrent) {
      const item = queue.shift();
      if (item == null) break;
      inflight++;
      void processItem(item);
    }
    if (inflight === 0 && queue.length === 0 && resolveAll) {
      resolveAll();
    }
  }

  await new Promise<void>((resolve) => {
    resolveAll = resolve;
    drain();
    if (inflight === 0 && queue.length === 0) resolve();
  });

  return files;
}

async function fetchDir(
  api: DirBrowser,
  dirId: DirId,
  basePath: string,
): Promise<{
  entries: [string, CloudFile][];
  subdirs: { dirId: DirId; basePath: string }[];
}> {
  const entries: [string, CloudFile][] = [];
  const subdirs: { dirId: DirId; basePath: string }[] = [];

  let data: Awaited<ReturnType<DirBrowser['getDirInfoById']>>;
  try {
    data = await api.getDirInfoById(dirId);
  } catch {
    return { entries, subdirs };
  }

  for (const entry of data.entries ?? []) {
    const fe = entry.fileEntry;
    const name = fe.name;
    if (name.startsWith('.')) continue;

    const rel = basePath ? `${basePath}/${name}` : name;
    const isDir = fe.dir ?? false;
    const eid = fe.id;

    const cloudFile: CloudFile = {
      id: isDir ? (eid as DirId) : (eid as FileId),
      parentId: dirId,
      name,
      isDir,
      mtime: fe.modifyTimeForSort ?? 0,
      ctime: fe.createTimeForSort ?? 0,
      domain: (fe.domain ?? 1) as NoteDomain,
    };

    if (isDir) {
      entries.push([rel, cloudFile]);
      subdirs.push({ dirId: eid as DirId, basePath: rel });
    } else {
      const localName = mapCloudName(name);
      const localRel = basePath ? `${basePath}/${localName}` : localName;
      entries.push([localRel, cloudFile]);
    }
  }

  return { entries, subdirs };
}
