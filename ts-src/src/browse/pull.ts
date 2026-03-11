/**
 * Pull engine — recursively download the entire cloud directory tree to local disk.
 *
 * Unlike `sync --pull`, this operates independently of the metadata store.
 * It walks the cloud tree via API and downloads every file, preserving
 * the directory structure.
 *
 * Ported from Python src/transfer/pull.py
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { YoudaoNoteApi } from '../api/client.js';
import type { DirId, FileId } from '../types/common.js';
import { asDirId, asFileId } from '../types/common.js';
import { downloadFile } from '../execute/download.js';
import { findFolderByPath } from './search.js';

interface DownloadTask {
  fileId: FileId;
  name: string;
  localDir: string;
  modifyTime: number;
}

const CONCURRENT_DOWNLOADS = 8;

export interface PullStats {
  total: number;
  succeeded: number;
  failed: number;
}

/**
 * Recursively download all files from the cloud to `localDir`.
 *
 * @param ydnoteDir  Only export this cloud subdirectory (e.g. "工作/项目"). Empty = root.
 */
export async function pullAll(
  api: YoudaoNoteApi,
  localDir: string,
  ydnoteDir?: string,
): Promise<PullStats> {
  mkdirSync(localDir, { recursive: true });

  let rootId: DirId;
  if (ydnoteDir) {
    const found = await findFolderByPath(api, ydnoteDir);
    if (!found) throw new Error(`Cloud folder not found: ${ydnoteDir}`);
    rootId = found;
  } else {
    rootId = await api.getRootId();
  }

  console.log(`Scanning cloud directory tree…`);
  const tasks = await collectTasks(api, rootId, localDir);
  console.log(`Found ${tasks.length} files to download.`);

  const stats = await executeTasks(api, tasks);
  console.log(
    `Pull complete: ${stats.succeeded} succeeded, ${stats.failed} failed out of ${stats.total}.`,
  );
  return stats;
}

async function collectTasks(
  api: YoudaoNoteApi,
  dirId: DirId,
  localDir: string,
): Promise<DownloadTask[]> {
  const tasks: DownloadTask[] = [];
  const dirInfo = await api.getDirInfoById(dirId);

  for (const entry of dirInfo.entries ?? []) {
    const fe = entry.fileEntry;
    const isDir = Boolean(fe.dir);

    if (isDir) {
      const subDir = join(localDir, fe.name);
      mkdirSync(subDir, { recursive: true });
      const sub = await collectTasks(api, asDirId(fe.id), subDir);
      tasks.push(...sub);
    } else {
      tasks.push({
        fileId: asFileId(fe.id),
        name: fe.name,
        localDir,
        modifyTime: fe.modifyTimeForSort ?? 0,
      });
    }
  }

  return tasks;
}

async function executeTasks(api: YoudaoNoteApi, tasks: DownloadTask[]): Promise<PullStats> {
  let succeeded = 0;
  let failed = 0;

  // Simple concurrency pool
  const queue = [...tasks];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      try {
        const localPath = join(task.localDir, task.name);
        await downloadFile(api, task.fileId, localPath, {
          cloudMtime: task.modifyTime,
        });
        succeeded++;
      } catch (e: unknown) {
        failed++;
        console.error(
          `Download failed: ${task.name} — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  const workerCount = Math.min(tasks.length, CONCURRENT_DOWNLOADS);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return { total: tasks.length, succeeded, failed };
}

/**
 * Download a single folder recursively from the cloud.
 */
export async function downloadFolder(
  api: YoudaoNoteApi,
  dirId: DirId,
  localDir: string,
): Promise<PullStats> {
  mkdirSync(localDir, { recursive: true });

  const tasks = await collectTasks(api, dirId, localDir);
  console.log(`Downloading ${tasks.length} files from folder…`);
  return executeTasks(api, tasks);
}
