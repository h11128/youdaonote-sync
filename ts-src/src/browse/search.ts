/**
 * Cloud search engine — recursive name search across the entire directory tree.
 *
 * Ported from Python src/transfer/search.py
 */

import type { YoudaoNoteApi } from '../api/client.js';
import type { DirId } from '../types/common.js';
import type { DirFileEntry } from '../types/dir.js';
import { asDirId } from '../types/common.js';

export type SearchType = 'all' | 'folder' | 'file';

export interface SearchResult {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifyTime: number;
  createTime: number;
  entry: DirFileEntry;
}

export interface DirectoryEntry {
  id: string;
  name: string;
  isDir: boolean;
  size: number;
  modifyTime: number;
  createTime: number;
  entry: DirFileEntry;
}

const MAX_SEARCH_DEPTH = 50;

function toDirectoryEntry(fe: DirFileEntry): DirectoryEntry {
  return {
    id: fe.id,
    name: fe.name,
    isDir: Boolean(fe.dir),
    size: fe.size ?? 0,
    modifyTime: fe.modifyTimeForSort ?? 0,
    createTime: fe.createTimeForSort ?? 0,
    entry: fe,
  };
}

/**
 * List contents of a directory, returning normalized entries.
 */
export async function getDirectoryEntries(
  api: YoudaoNoteApi,
  dirId?: DirId,
): Promise<DirectoryEntry[]> {
  const id = dirId ?? (await api.getRootId());
  const dirInfo = await api.getDirInfoById(id);
  return (dirInfo.entries ?? []).map((e) => toDirectoryEntry(e.fileEntry));
}

interface SearchContext {
  api: YoudaoNoteApi;
  targetName: string;
  lowerTarget: string;
  searchType: SearchType;
  exactMatch: boolean;
  results: SearchResult[];
}

function isNameMatch(ctx: SearchContext, name: string): boolean {
  return ctx.exactMatch ? name === ctx.targetName : name.toLowerCase().includes(ctx.lowerTarget);
}

function shouldInclude(ctx: SearchContext, isDir: boolean): boolean {
  return (
    ctx.searchType === 'all' ||
    (ctx.searchType === 'folder' && isDir) ||
    (ctx.searchType === 'file' && !isDir)
  );
}

/**
 * Search files/folders by name recursively across the entire cloud tree.
 */
export async function searchByName(
  api: YoudaoNoteApi,
  name: string,
  searchType: SearchType = 'all',
  exactMatch = false,
): Promise<SearchResult[]> {
  if (!name) throw new Error('Search name must not be empty');

  const rootId = await api.getRootId();
  const ctx: SearchContext = {
    api,
    targetName: name,
    lowerTarget: name.toLowerCase(),
    searchType,
    exactMatch,
    results: [],
  };
  await walkSearch(ctx, rootId, '', 0);
  return ctx.results;
}

async function walkSearch(
  ctx: SearchContext,
  dirId: DirId,
  currentPath: string,
  depth: number,
): Promise<void> {
  if (depth >= MAX_SEARCH_DEPTH) return;

  let dirInfo;
  try {
    dirInfo = await ctx.api.getDirInfoById(dirId);
  } catch (e: unknown) {
    console.error(`Error searching ${currentPath}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  for (const entry of dirInfo.entries ?? []) {
    const fe = entry.fileEntry;
    const entryPath = currentPath ? `${currentPath}/${fe.name}` : fe.name;
    const isDir = Boolean(fe.dir);

    if (isNameMatch(ctx, fe.name) && shouldInclude(ctx, isDir)) {
      ctx.results.push({
        ...toDirectoryEntry(fe),
        path: entryPath,
      });
    }

    if (isDir) {
      await walkSearch(ctx, asDirId(fe.id), entryPath, depth + 1);
    }
  }
}

/**
 * Find a folder by its path (e.g. "folder1/folder2").
 * Returns the DirId, or null if not found.
 */
export async function findFolderByPath(api: YoudaoNoteApi, path: string): Promise<DirId | null> {
  if (!path || path === '/') return api.getRootId();

  const parts = path.split('/').filter(Boolean);
  let currentId = await api.getRootId();

  for (const part of parts) {
    const dirInfo = await api.getDirInfoById(currentId);
    let found = false;

    for (const entry of dirInfo.entries ?? []) {
      const fe = entry.fileEntry;
      if (fe.dir && fe.name === part) {
        currentId = asDirId(fe.id);
        found = true;
        break;
      }
    }

    if (!found) return null;
  }

  return currentId;
}
