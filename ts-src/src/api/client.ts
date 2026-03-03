import { randomUUID } from 'node:crypto';
import type { CookieEntry } from './cookies.js';
import { loadCookies, loadFromDesktop, saveCookies } from './cookies.js';
import type { DirId, FileId } from '../types/common.js';
import type { DirInfoByIdResponse } from '../types/dir.js';
import { NoteDomain } from '../types/common.js';
import { ROOT_ID_URL, FILE_URL, LIST_RECENT_URL, tpl, BASE_HEADERS } from './constants.js';
import { safeJson } from './request.js';
import { fetchDirList } from './dir.js';
import * as fileApi from './file-api.js';

export class YoudaoNoteApi {
  private cookiesPath: string;
  private cstk: string | null = null;
  private cookieHeader = '';
  private cachedRootId: DirId | null = null;

  constructor(cookiesPath: string) {
    this.cookiesPath = cookiesPath;
  }

  // ========== Auth ==========

  private applyCookies(cookies: CookieEntry[]): string | null {
    this.cookieHeader = cookies
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    this.cstk = null;
    for (const c of cookies) {
      if (c.name === 'YNOTE_CSTK') {
        this.cstk = c.value;
        break;
      }
    }
    return this.cstk ? null : 'YNOTE_CSTK is empty';
  }

  loginByCookies(): string | null {
    const { cookies, error } = loadCookies(this.cookiesPath);
    if (!error && cookies.length > 0) {
      const err = this.applyCookies(cookies);
      if (!err) return null;
    }

    const desktop = loadFromDesktop();
    if (desktop.error) {
      return `Cookie load failed — file: ${error || 'ok'}, desktop: ${desktop.error}`;
    }
    const err = this.applyCookies(desktop.cookies);
    if (err) return err;

    saveCookies({ cookies: desktop.cookies }, this.cookiesPath);
    return null;
  }

  private requireAuth(): void {
    if (!this.cstk) {
      throw new Error('Not logged in: cstk is empty. Call loginByCookies() first.');
    }
  }

  private refreshSession(): boolean {
    const { cookies, error } = loadFromDesktop();
    if (error) return false;
    const err = this.applyCookies(cookies);
    if (err) return false;
    saveCookies({ cookies }, this.cookiesPath);
    return true;
  }

  // ========== HTTP ==========

  private async httpPost(
    url: string,
    body?: URLSearchParams | FormData,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      Cookie: this.cookieHeader,
    };
    if (body instanceof URLSearchParams) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const fetchOpts: RequestInit = { method: 'POST', headers };
    if (body) fetchOpts.body = body;

    let resp = await fetch(url, fetchOpts);

    if (await this.isAuthError(resp) && this.refreshSession()) {
      url = this.refreshUrl(url);
      if (body instanceof URLSearchParams && body.has('cstk') && this.cstk) {
        body.set('cstk', this.cstk);
      }
      headers['Cookie'] = this.cookieHeader;
      const retryOpts: RequestInit = { method: 'POST', headers };
      if (body) retryOpts.body = body;
      resp = await fetch(url, retryOpts);
    }

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    return resp;
  }

  private async httpGet(url: string): Promise<Response> {
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      Cookie: this.cookieHeader,
    };

    let resp = await fetch(url, { headers });

    if (await this.isAuthError(resp) && this.refreshSession()) {
      url = this.refreshUrl(url);
      headers['Cookie'] = this.cookieHeader;
      resp = await fetch(url, { headers });
    }

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    return resp;
  }

  private async isAuthError(resp: Response): Promise<boolean> {
    if (resp.status === 401 || resp.status === 403) return true;
    if (resp.status === 500) {
      try {
        const body = await resp.clone().text();
        if (body.includes('error=207') || body.includes('AUTHENTICATION_FAILURE')) return true;
      } catch { /* ignore read errors */ }
    }
    return false;
  }

  private refreshUrl(url: string): string {
    if (this.cstk && url.includes('cstk=')) {
      return url.replace(/cstk=[^&]+/, `cstk=${this.cstk}`);
    }
    return url;
  }

  // ========== API Methods ==========

  static generateFileId(): FileId {
    return ('WEB' + randomUUID().replace(/-/g, '')) as FileId;
  }

  async getRootId(): Promise<DirId> {
    if (this.cachedRootId) return this.cachedRootId;
    this.requireAuth();
    const params = new URLSearchParams({
      path: '/',
      entire: 'true',
      purge: 'false',
      cstk: this.cstk!,
    });
    const url = tpl(ROOT_ID_URL, { cstk: this.cstk! });
    const data = await safeJson(await this.httpPost(url, params));

    const fe = data['fileEntry'] as Record<string, unknown> | undefined;
    if (fe?.['id']) {
      this.cachedRootId = fe['id'] as DirId;
    } else if (data['id']) {
      this.cachedRootId = data['id'] as DirId;
    } else {
      throw new Error(`Cannot extract root dir ID from API response`);
    }
    return this.cachedRootId;
  }

  async getDirInfoById(dirId: DirId): Promise<DirInfoByIdResponse> {
    if (!dirId) throw new Error('dirId must not be empty');
    this.requireAuth();
    return fetchDirList(
      { httpGet: (u) => this.httpGet(u), getCstk: () => this.cstk! },
      dirId,
    );
  }

  async getFileById(fileId: FileId): Promise<ArrayBuffer> {
    if (!fileId) throw new Error('fileId must not be empty');
    this.requireAuth();

    const params = new URLSearchParams({
      fileId,
      version: '-1',
      convert: 'true',
      editorType: '1',
      cstk: this.cstk!,
    });
    const url = tpl(FILE_URL, { cstk: this.cstk! });
    const resp = await this.httpPost(url, params);
    return resp.arrayBuffer();
  }

  async pushFile(opts: {
    fileId: FileId;
    parentId: DirId;
    name: string;
    domain: NoteDomain;
    bodyString: string;
    createTime?: number;
    modifyTime?: number;
    isCreate?: boolean;
  }): Promise<Record<string, unknown>> {
    return fileApi.pushFile(this.asFileApiContext(), opts);
  }

  async createDir(parentId: DirId, name: string): Promise<Record<string, unknown>> {
    return fileApi.createDir(
      this.asFileApiContext(),
      parentId,
      name,
      () => YoudaoNoteApi.generateFileId(),
    );
  }

  async deleteFile(fileId: FileId): Promise<Record<string, unknown>> {
    return fileApi.deleteFile(this.asFileApiContext(), fileId);
  }

  async moveFile(fileId: FileId, newParentId: DirId, domain = 1): Promise<Record<string, unknown>> {
    return fileApi.moveFile(this.asFileApiContext(), fileId, newParentId, domain);
  }

  async renameFile(fileId: FileId, newName: string, domain = 1): Promise<Record<string, unknown>> {
    return fileApi.renameFile(this.asFileApiContext(), fileId, newName, domain);
  }

  /**
   * Fetch recently modified files (ordered by modify time, descending).
   * API maximum is 30 items per call.
   */
  async listRecent(limit = 30): Promise<Array<Record<string, unknown>>> {
    this.requireAuth();
    const url = tpl(LIST_RECENT_URL, { cstk: this.cstk! });
    const params = new URLSearchParams({
      offset: '0',
      limit: String(Math.min(limit, 30)),
    });
    const resp = await this.httpPost(url, params);
    const json = await safeJson(resp);
    return Array.isArray(json) ? json : [];
  }

  private asFileApiContext(): fileApi.FileApiContext {
    return {
      httpPost: (url, body) => this.httpPost(url, body),
      getCstk: () => this.cstk!,
      requireAuth: () => this.requireAuth(),
    };
  }
}
