import type { FileId } from '../types/common.js';
import { FILE_URL, LIST_RECENT_URL, tpl } from './constants.js';
import { safeJson } from './request.js';
import type { FileApiContext } from './file-api.js';
import { requireNonEmpty } from '../util/preconditions.js';

/**
 * Download note or voice-clip bytes.
 * Use `convert: false` for `.audio` recordID clip binaries.
 */
export async function getFileById(
  ctx: FileApiContext,
  fileId: FileId,
  opts?: { convert?: boolean },
): Promise<ArrayBuffer> {
  requireNonEmpty('fileId', fileId);
  ctx.requireAuth();
  const cstk = ctx.getCstk();
  const convert = opts?.convert ?? true;
  const params = new URLSearchParams({
    fileId,
    version: '-1',
    convert: String(convert),
    editorType: '1',
    cstk,
  });
  const url = tpl(FILE_URL, { cstk });
  const resp = await ctx.httpPost(url, params);
  return resp.arrayBuffer();
}

export async function getFileInfo(
  ctx: FileApiContext,
  fileId: FileId,
): Promise<Record<string, unknown>> {
  requireNonEmpty('fileId', fileId);
  ctx.requireAuth();
  const cstk = ctx.getCstk();
  const url =
    `https://note.youdao.com/yws/api/personal/file/${fileId}` +
    `?method=getById&keyfrom=web&cstk=${cstk}`;
  const params = new URLSearchParams({ cstk });
  return safeJson(await ctx.httpPost(url, params));
}

/** Recently modified files (API max 30 per call). */
export async function listRecent(
  ctx: FileApiContext,
  limit = 30,
): Promise<Record<string, unknown>[]> {
  ctx.requireAuth();
  const cstk = ctx.getCstk();
  const url = tpl(LIST_RECENT_URL, { cstk });
  const params = new URLSearchParams({
    offset: '0',
    limit: String(Math.min(limit, 30)),
  });
  const resp = await ctx.httpPost(url, params);
  const json = await safeJson(resp);
  return Array.isArray(json) ? json : [];
}
