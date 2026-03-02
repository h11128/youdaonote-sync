import type { DirId, FileId } from '../types/common.js';
import { NoteDomain } from '../types/common.js';
import { PUSH_URL, DELETE_URL, tpl } from './constants.js';
import { safeJson } from './request.js';

export interface FileApiContext {
  httpPost(url: string, body?: URLSearchParams | FormData): Promise<Response>;
  getCstk(): string;
  requireAuth(): void;
}

export async function pushFile(
  ctx: FileApiContext,
  opts: {
    fileId: FileId;
    parentId: DirId;
    name: string;
    domain: NoteDomain;
    bodyString: string;
    createTime?: number;
    modifyTime?: number;
    isCreate?: boolean;
  },
): Promise<Record<string, unknown>> {
  ctx.requireAuth();
  const now = Math.floor(Date.now() / 1000);
  const ct = opts.createTime ?? now;
  const mt = opts.modifyTime ?? now;

  const params = new URLSearchParams({
    fileId: opts.fileId,
    parentId: opts.parentId,
    domain: String(opts.domain),
    rootVersion: '-1',
    sessionId: '',
    modifyTime: String(mt),
    bodyString: opts.bodyString,
    transactionId: opts.fileId,
    transactionTime: String(mt),
    cstk: ctx.getCstk(),
  });

  if (opts.isCreate) {
    params.set('name', opts.name);
    params.set('dir', 'false');
    params.set('createTime', String(ct));
    params.set('req_from', 'create');
  } else {
    params.set('req_from', 'save');
  }

  if (opts.domain === NoteDomain.MARKDOWN) {
    params.set('tags', '');
    params.set('resources', ';');
  } else {
    params.set('editorVersion', '1714445486000');
    params.set('orgEditorType', '1');
    params.set('summary', opts.bodyString.slice(0, 50));
    params.set('tags', '');
  }

  const url = tpl(PUSH_URL, { cstk: ctx.getCstk() });
  return safeJson(await ctx.httpPost(url, params));
}

export async function createDir(
  ctx: FileApiContext,
  parentId: DirId,
  name: string,
  generateFileId: () => FileId,
): Promise<Record<string, unknown>> {
  if (!parentId) throw new Error('parentId must not be empty');
  if (!name) throw new Error('name must not be empty');
  ctx.requireAuth();

  const now = Math.floor(Date.now() / 1000);
  const fileId = generateFileId();

  const params = new URLSearchParams({
    fileId,
    parentId,
    name,
    dir: 'true',
    domain: '0',
    rootVersion: '-1',
    sessionId: '',
    createTime: String(now),
    modifyTime: String(now),
    transactionId: fileId,
    transactionTime: String(now),
    cstk: ctx.getCstk(),
  });

  const url = tpl(PUSH_URL, { cstk: ctx.getCstk() });
  const result = await safeJson(await ctx.httpPost(url, params));

  if (result['error'] === '20108') {
    const dupId = result['duplicateFileId'] as string | undefined;
    if (dupId) {
      return { fileEntry: { id: dupId, name, dir: true } };
    }
  }

  if (result['entry'] && !result['fileEntry']) {
    result['fileEntry'] = result['entry'];
  }

  return result;
}

export async function deleteFile(ctx: FileApiContext, fileId: FileId): Promise<Record<string, unknown>> {
  if (!fileId) throw new Error('fileId must not be empty');
  ctx.requireAuth();
  const url = tpl(DELETE_URL, { file_id: fileId, cstk: ctx.getCstk() });
  const params = new URLSearchParams({ cstk: ctx.getCstk() });
  return safeJson(await ctx.httpPost(url, params));
}

export async function moveFile(
  ctx: FileApiContext,
  fileId: FileId,
  newParentId: DirId,
  domain = 1,
): Promise<Record<string, unknown>> {
  if (!fileId) throw new Error('fileId must not be empty');
  if (!newParentId) throw new Error('newParentId must not be empty');
  ctx.requireAuth();

  const now = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    fileId,
    parentId: newParentId,
    domain: String(domain),
    rootVersion: '-1',
    sessionId: '',
    modifyTime: String(now),
    transactionId: fileId,
    transactionTime: String(now),
    cstk: ctx.getCstk(),
  });

  const url = tpl(PUSH_URL, { cstk: ctx.getCstk() });
  return safeJson(await ctx.httpPost(url, params));
}

export async function renameFile(
  ctx: FileApiContext,
  fileId: FileId,
  newName: string,
  domain = 1,
): Promise<Record<string, unknown>> {
  if (!fileId) throw new Error('fileId must not be empty');
  if (!newName) throw new Error('newName must not be empty');
  ctx.requireAuth();

  const now = Math.floor(Date.now() / 1000);
  const url =
    `https://note.youdao.com/yws/api/personal/sync?method=push` +
    `&name=${encodeURIComponent(newName)}` +
    `&fileId=${fileId}&domain=${domain}&rootVersion=-1&sessionId=` +
    `&modifyTime=${now}&transactionId=${fileId}&transactionTime=${now}` +
    `&editorVersion=1714445486000&tags=&keyfrom=web&cstk=${ctx.getCstk()}`;
  const params = new URLSearchParams({ cstk: ctx.getCstk() });
  return safeJson(await ctx.httpPost(url, params));
}
