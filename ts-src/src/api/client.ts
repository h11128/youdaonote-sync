import { randomUUID } from 'node:crypto';
import type { CookieEntry } from './cookies.js';
import { loadCookies, loadFromDesktop, saveCookies } from './cookies.js';
import type { DirId, FileId } from '../types/common.js';
import { NoteDomain } from '../types/common.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/100.0.4896.88 Safari/537.36';

const BASE_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'sec-ch-ua': '" Not A;Brand";v="99", "Chromium";v="100", "Google Chrome";v="100"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

const ROOT_ID_URL = 'https://note.youdao.com/yws/api/personal/file?method=getByPath&keyfrom=web&cstk={cstk}';
const DIR_MES_URL =
  'https://note.youdao.com/yws/api/personal/file/{dir_id}?all=true&f=true&len={page_size}&sort=1' +
  '&isReverse=false&method=listPageByParentId&keyfrom=web&cstk={cstk}';
const FILE_URL =
  'https://note.youdao.com/yws/api/personal/sync?method=download&_system=macos&_systemVersion=&' +
  '_screenWidth=1280&_screenHeight=800&_appName=ynote&_appuser=0123456789abcdeffedcba9876543210&' +
  '_vendor=official-website&_launch=16&_firstTime=&_deviceId=0123456789abcdef&_platform=web&' +
  '_cityCode=110000&_cityName=&sev=j1&keyfrom=web&cstk={cstk}';
const PUSH_URL =
  'https://note.youdao.com/yws/api/personal/sync?method=push&_system=windows&_systemVersion=&' +
  '_screenWidth=1400&_screenHeight=900&_appName=ynote&_appuser=0123456789abcdeffedcba9876543210&' +
  '_vendor=official-website&_launch=1&_firstTime=&_deviceId=0123456789abcdef&_platform=web&' +
  '_cityCode=&_cityName=&_product=YNote-Web&_version=&sev=j1&sec=v1&keyfrom=web&cstk={cstk}';
const DELETE_URL =
  'https://note.youdao.com/yws/api/personal/file/{file_id}?method=delete&keyfrom=web&cstk={cstk}';

const DIR_PAGE_SIZE = 9999;

function tpl(url: string, vars: Record<string, string>): string {
  let result = url;
  for (const [k, v] of Object.entries(vars)) {
    result = result.replaceAll(`{${k}}`, v);
  }
  return result;
}

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

    if (this.isAuthError(resp) && this.refreshSession()) {
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

    if (this.isAuthError(resp) && this.refreshSession()) {
      url = this.refreshUrl(url);
      headers['Cookie'] = this.cookieHeader;
      resp = await fetch(url, { headers });
    }

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    return resp;
  }

  private isAuthError(resp: Response): boolean {
    if (resp.status === 401 || resp.status === 403) return true;
    return false;
  }

  private refreshUrl(url: string): string {
    if (this.cstk && url.includes('cstk=')) {
      return url.replace(/cstk=[^&]+/, `cstk=${this.cstk}`);
    }
    return url;
  }

  private static async safeJson(resp: Response): Promise<Record<string, unknown>> {
    try {
      return await resp.json() as Record<string, unknown>;
    } catch {
      const text = await resp.text().catch(() => '(empty)');
      throw new Error(`API returned non-JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`);
    }
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
    const data = await YoudaoNoteApi.safeJson(await this.httpPost(url, params));

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

  async getDirInfoById(dirId: DirId): Promise<{
    count: number;
    entries: Array<{ fileEntry: Record<string, unknown> }>;
  }> {
    if (!dirId) throw new Error('dirId must not be empty');
    this.requireAuth();

    const allEntries: Array<{ fileEntry: Record<string, unknown> }> = [];
    const seenIds = new Set<string>();
    let offset = 0;
    const maxPages = 50;

    for (let page = 0; page < maxPages; page++) {
      let url = tpl(DIR_MES_URL, {
        dir_id: dirId,
        page_size: String(DIR_PAGE_SIZE),
        cstk: this.cstk!,
      });
      if (offset > 0) url += `&startIndex=${offset}`;

      const data = await YoudaoNoteApi.safeJson(await this.httpGet(url));
      const entries = (data['entries'] as Array<Record<string, unknown>> | undefined) ?? [];
      const total = (data['count'] as number | undefined) ?? 0;

      if (entries.length === 0) break;

      let newCount = 0;
      for (const entry of entries) {
        const fe = (entry['fileEntry'] as Record<string, unknown>) ?? {};
        const eid = String(fe['id'] ?? '');
        if (eid && !seenIds.has(eid)) {
          seenIds.add(eid);
          allEntries.push({ fileEntry: fe });
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
    this.requireAuth();
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
      cstk: this.cstk!,
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

    const url = tpl(PUSH_URL, { cstk: this.cstk! });
    return YoudaoNoteApi.safeJson(await this.httpPost(url, params));
  }

  async createDir(parentId: DirId, name: string): Promise<Record<string, unknown>> {
    if (!parentId) throw new Error('parentId must not be empty');
    if (!name) throw new Error('name must not be empty');
    this.requireAuth();

    const now = Math.floor(Date.now() / 1000);
    const fileId = YoudaoNoteApi.generateFileId();

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
      cstk: this.cstk!,
    });

    const url = tpl(PUSH_URL, { cstk: this.cstk! });
    const result = await YoudaoNoteApi.safeJson(await this.httpPost(url, params));

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

  async deleteFile(fileId: FileId): Promise<Record<string, unknown>> {
    if (!fileId) throw new Error('fileId must not be empty');
    this.requireAuth();
    const url = tpl(DELETE_URL, { file_id: fileId, cstk: this.cstk! });
    const params = new URLSearchParams({ cstk: this.cstk! });
    return YoudaoNoteApi.safeJson(await this.httpPost(url, params));
  }

  async moveFile(fileId: FileId, newParentId: DirId, domain = 1): Promise<Record<string, unknown>> {
    if (!fileId) throw new Error('fileId must not be empty');
    if (!newParentId) throw new Error('newParentId must not be empty');
    this.requireAuth();

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
      cstk: this.cstk!,
    });

    const url = tpl(PUSH_URL, { cstk: this.cstk! });
    return YoudaoNoteApi.safeJson(await this.httpPost(url, params));
  }

  async renameFile(fileId: FileId, newName: string, domain = 1): Promise<Record<string, unknown>> {
    if (!fileId) throw new Error('fileId must not be empty');
    if (!newName) throw new Error('newName must not be empty');
    this.requireAuth();

    const now = Math.floor(Date.now() / 1000);
    const url =
      `https://note.youdao.com/yws/api/personal/sync?method=push` +
      `&name=${encodeURIComponent(newName)}` +
      `&fileId=${fileId}&domain=${domain}&rootVersion=-1&sessionId=` +
      `&modifyTime=${now}&transactionId=${fileId}&transactionTime=${now}` +
      `&editorVersion=1714445486000&tags=&keyfrom=web&cstk=${this.cstk}`;
    const params = new URLSearchParams({ cstk: this.cstk! });
    return YoudaoNoteApi.safeJson(await this.httpPost(url, params));
  }
}
