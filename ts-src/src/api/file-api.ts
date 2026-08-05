import type { DirId, FileId } from '../types/common.js';
import { NoteDomain } from '../types/common.js';
import { PUSH_URL, DELETE_URL, tpl } from './constants.js';
import { assertPushResultOk, resolveDuplicateFileId } from './push-errors.js';
import { safeJson } from './request.js';
import { requireNonEmpty } from '../util/preconditions.js';

function required(name: string, value: string): void {
  requireNonEmpty(name, value);
}

export interface FileApiContext {
  httpPost(url: string, body?: URLSearchParams | FormData): Promise<Response>;
  getCstk(): string;
  requireAuth(): void;
}

function finishPushResult(result: Record<string, unknown>, name: string): Record<string, unknown> {
  const dupId = resolveDuplicateFileId(result);
  if (dupId) {
    return { fileEntry: { id: dupId, name, dir: false }, duplicateFileId: dupId };
  }
  assertPushResultOk(result);
  if (result.entry && !result.fileEntry) {
    result.fileEntry = result.entry;
  }
  return result;
}

function applyCreateOrSaveFields(
  target: { set(k: string, v: string): void },
  opts: { name: string; isCreate?: boolean | undefined; createTime: number },
): void {
  if (opts.isCreate) {
    target.set('name', opts.name);
    target.set('dir', 'false');
    target.set('createTime', String(opts.createTime));
    target.set('req_from', 'create');
  } else {
    target.set('req_from', 'save');
  }
}

function buildPushFileParams(
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
): URLSearchParams {
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
  applyCreateOrSaveFields(params, { name: opts.name, isCreate: opts.isCreate, createTime: ct });
  if (opts.domain === NoteDomain.MARKDOWN) {
    params.set('tags', '');
    params.set('resources', ';');
  } else {
    params.set('editorVersion', '1714445486000');
    params.set('orgEditorType', '1');
    params.set('summary', opts.bodyString.slice(0, 50));
    params.set('tags', '');
  }
  return params;
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
  const url = tpl(PUSH_URL, { cstk: ctx.getCstk() });
  const params = buildPushFileParams(ctx, opts);
  return finishPushResult(await safeJson(await ctx.httpPost(url, params)), opts.name);
}

export async function createDir(
  ctx: FileApiContext,
  parentId: DirId,
  name: string,
  generateFileId: () => FileId,
): Promise<Record<string, unknown>> {
  required('parentId', parentId);
  required('name', name);
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

  const dupId = resolveDuplicateFileId(result);
  if (dupId) {
    return { fileEntry: { id: dupId, name, dir: true }, duplicateFileId: dupId };
  }
  assertPushResultOk(result);

  if (result.entry && !result.fileEntry) {
    result.fileEntry = result.entry;
  }

  return result;
}

export async function deleteFile(
  ctx: FileApiContext,
  fileId: FileId,
): Promise<Record<string, unknown>> {
  required('fileId', fileId);
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
  required('fileId', fileId);
  required('newParentId', newParentId);
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
  required('fileId', fileId);
  required('newName', newName);
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

const EXT_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

function guessMime(name: string): string {
  const lastDot = name.lastIndexOf('.');
  const ext = lastDot >= 0 ? name.slice(lastDot).toLowerCase() : '';
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

/**
 * Upload a binary file (PDF, images, etc.) via multipart/form-data.
 * Uses the same PUSH_URL but sends file content as a multipart file field.
 */
export async function pushBinaryFile(
  ctx: FileApiContext,
  opts: {
    fileId: FileId;
    parentId: DirId;
    name: string;
    fileData: Uint8Array;
    createTime?: number;
    modifyTime?: number;
    isCreate?: boolean;
  },
): Promise<Record<string, unknown>> {
  required('fileId', opts.fileId);
  required('parentId', opts.parentId);
  required('name', opts.name);
  ctx.requireAuth();

  const now = Math.floor(Date.now() / 1000);
  const ct = opts.createTime ?? now;
  const mt = opts.modifyTime ?? now;

  const form = new FormData();
  form.set('fileId', opts.fileId);
  form.set('parentId', opts.parentId);
  form.set('domain', String(NoteDomain.MARKDOWN));
  form.set('rootVersion', '-1');
  form.set('sessionId', '');
  form.set('modifyTime', String(mt));
  form.set('transactionId', opts.fileId);
  form.set('transactionTime', String(mt));
  form.set('cstk', ctx.getCstk());
  form.set('tags', '');
  form.set('resources', ';');
  applyCreateOrSaveFields(form, { name: opts.name, isCreate: opts.isCreate, createTime: ct });

  const mime = guessMime(opts.name);
  const blob = new Blob([opts.fileData], { type: mime });
  form.set('file', blob, opts.name);

  const url = tpl(PUSH_URL, { cstk: ctx.getCstk() });
  return finishPushResult(await safeJson(await ctx.httpPost(url, form)), opts.name);
}
