import type { DirId } from '../types/common.js';
import type { DirFileEntry, DirInfoByIdResponse } from '../types/dir.js';
import { DIR_MES_URL, DIR_PAGE_SIZE, tpl } from './constants.js';
import { safeJson } from './request.js';

export interface DirListContext {
  httpGet(url: string): Promise<Response>;
  getCstk(): string;
}

export async function fetchDirList(
  ctx: DirListContext,
  dirId: DirId,
): Promise<DirInfoByIdResponse> {
  const allEntries: Array<{ fileEntry: DirFileEntry }> = [];
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
    const entries = (data['entries'] as Array<Record<string, unknown>> | undefined) ?? [];
    const total = (data['count'] as number | undefined) ?? 0;

    if (entries.length === 0) break;

    let newCount = 0;
    for (const entry of entries) {
      const fe = (entry['fileEntry'] as Record<string, unknown>) ?? {};
      const eid = String(fe['id'] ?? '');
      if (eid && !seenIds.has(eid)) {
        seenIds.add(eid);
        allEntries.push({ fileEntry: fe as unknown as DirFileEntry });
        newCount++;
      }
    }

    offset += entries.length;
    if (newCount === 0 || allEntries.length >= total || entries.length < DIR_PAGE_SIZE) {
      break;
    }
  }

  return { count: allEntries.length, entries: allEntries };
}
