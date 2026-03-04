import type { DirId } from '../types/common.js';
import type { DirFileEntry, DirInfoByIdResponse } from '../types/dir.js';
import { DIR_MES_URL, DIR_PAGE_SIZE, tpl } from './constants.js';
import { safeJson } from './request.js';

export interface DirListContext {
  httpGet(url: string): Promise<Response>;
  getCstk(): string;
}

function extractEntryId(fe: Record<string, unknown>): string {
  const rawId = fe.id;
  if (typeof rawId === 'string') return rawId;
  if (typeof rawId === 'number') return String(rawId);
  return '';
}

function processDirPage(
  entries: Record<string, unknown>[],
  seenIds: Set<string>,
  allEntries: { fileEntry: DirFileEntry }[],
): number {
  let newCount = 0;
  for (const entry of entries) {
    const fe = (entry.fileEntry ?? {}) as Record<string, unknown>;
    const eid = extractEntryId(fe);
    if (eid && !seenIds.has(eid)) {
      seenIds.add(eid);
      allEntries.push({ fileEntry: fe as unknown as DirFileEntry });
      newCount++;
    }
  }
  return newCount;
}

export async function fetchDirList(
  ctx: DirListContext,
  dirId: DirId,
): Promise<DirInfoByIdResponse> {
  const allEntries: { fileEntry: DirFileEntry }[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  const maxPages = 50;

  for (let page = 0; page < maxPages; page++) {
    let url = tpl(DIR_MES_URL, {
      dir_id: dirId,
      page_size: String(DIR_PAGE_SIZE),
      cstk: ctx.getCstk(),
    });
    if (offset > 0) url += `&startIndex=${offset}`;

    const data = await safeJson(await ctx.httpGet(url));
    const entries = Array.isArray(data.entries) ? (data.entries as Record<string, unknown>[]) : [];

    if (entries.length === 0) break;

    const newCount = processDirPage(entries, seenIds, allEntries);
    const countVal = data.count;
    const total = typeof countVal === 'number' ? countVal : 0;

    offset += entries.length;
    if (newCount === 0 || allEntries.length >= total || entries.length < DIR_PAGE_SIZE) {
      break;
    }
  }

  return { count: allEntries.length, entries: allEntries };
}
