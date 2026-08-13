/**
 * Probe Youdao recycle / recent / version history for diary recovery.
 * Never deletes. Usage (from ts-src):
 *   npx tsx scripts/inspect-youdao-recycle.mts [名称片段]
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { YoudaoNoteApi } from '../src/api/client.ts';
import { FILE_URL, tpl } from '../src/api/constants.ts';
import { findFolderByPath, getDirectoryEntries } from '../src/browse/search.ts';
import { jsonBytesToMarkdown } from '../src/convert/json-to-md.ts';
import { asFileId } from '../src/types/common.ts';

const needle = process.argv[2] ?? '8月11日';
const configDir = execSync('node dist/bin.js config path', { encoding: 'utf8' }).trim();
const api = new YoudaoNoteApi(join(configDir, 'cookies.json'));
const loginErr = api.loginByCookies();
if (loginErr) throw new Error(loginErr);

const cookie = api.getCookieHeader();
const cstk = /YNOTE_CSTK=([^;]+)/.exec(cookie)?.[1];
if (!cstk) throw new Error('no YNOTE_CSTK');

function nameOf(row: Record<string, unknown>): string {
  const fe = row.fileEntry as Record<string, unknown> | undefined;
  return String(fe?.name ?? row.name ?? '');
}

function idOf(row: Record<string, unknown>): string {
  const fe = row.fileEntry as Record<string, unknown> | undefined;
  return String(fe?.id ?? row.id ?? '');
}

async function postJson(url: string, body?: URLSearchParams): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {
    Cookie: cookie,
    Accept: '*/*',
  };
  const opts: RequestInit = { method: 'POST', headers };
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = body;
  }
  const resp = await fetch(url, opts);
  return { status: resp.status, text: await resp.text() };
}

async function getJson(url: string): Promise<{ status: number; text: string }> {
  const resp = await fetch(url, { headers: { Cookie: cookie, Accept: '*/*' } });
  return { status: resp.status, text: await resp.text() };
}

console.log('==== listRecent (30) matching', needle, '====');
const recent = await api.listRecent(30);
for (const row of recent) {
  const n = nameOf(row);
  if (n.includes(needle) || n.includes('冲突') || n.includes('回收')) {
    console.log(JSON.stringify({ name: n, id: idOf(row), keys: Object.keys(row) }));
  }
}
console.log('recent total', recent.length, 'sample names', recent.slice(0, 8).map(nameOf));

console.log('==== live folder 2026 matching', needle, '====');
const folderId = await findFolderByPath(api, '内在世界/日记/2026');
if (folderId) {
  const entries = await getDirectoryEntries(api, folderId);
  for (const e of entries.filter((x) => x.name.includes(needle))) {
    const info = await api.getFileInfo(asFileId(e.id));
    const fe = (info.fileEntry ?? info) as Record<string, unknown>;
    console.log(
      e.name,
      'id',
      e.id,
      'ver',
      fe.version ?? fe.fileVersion ?? fe.lv,
      'mtime',
      fe.modifyTime ?? fe.tm,
    );
    const url = tpl(FILE_URL, { cstk });
    for (const ver of ['-1', '0', '1', '2', '3']) {
      const params = new URLSearchParams({
        fileId: e.id,
        version: ver,
        convert: 'false',
        editorType: '1',
        cstk,
      });
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params,
        });
        const buf = new Uint8Array(await resp.arrayBuffer());
        let md = 0;
        if (buf.length > 2 && buf[0] === 0x7b) md = jsonBytesToMarkdown(buf).trim().length;
        else md = Buffer.from(buf).toString('utf8').trim().length;
        console.log(`  version=${ver} http=${resp.status} raw=${buf.length} mdChars=${md}`);
      } catch (err) {
        console.log(`  version=${ver} err=${String(err).slice(0, 120)}`);
      }
    }
  }
}

const probes: Array<{ label: string; kind: 'get' | 'post'; url: string; body?: URLSearchParams }> = [
  {
    label: 'recycle list',
    kind: 'post',
    url: `https://note.youdao.com/yws/api/personal/recycle?method=list&keyfrom=web&cstk=${cstk}`,
    body: new URLSearchParams({ cstk, offset: '0', limit: '100' }),
  },
  {
    label: 'recycle getRecycleList',
    kind: 'post',
    url: `https://note.youdao.com/yws/api/personal/recycle?method=getRecycleList&keyfrom=web&cstk=${cstk}`,
    body: new URLSearchParams({ cstk, start: '0', len: '100' }),
  },
  {
    label: 'file listDeleted',
    kind: 'post',
    url: `https://note.youdao.com/yws/api/personal/file?method=listDeleted&keyfrom=web&cstk=${cstk}`,
    body: new URLSearchParams({ cstk, start: '0', len: '100' }),
  },
  {
    label: 'file listRecycle',
    kind: 'get',
    url: `https://note.youdao.com/yws/api/personal/file?method=listRecycle&keyfrom=web&cstk=${cstk}&len=100`,
  },
  {
    label: 'path 回收站',
    kind: 'post',
    url: `https://note.youdao.com/yws/api/personal/file?method=getByPath&keyfrom=web&cstk=${cstk}`,
    // purge=true means bypass cache (Youdao getByPath), not delete.
    body: new URLSearchParams({ path: '/回收站', entire: 'true', purge: 'true', cstk }),
  },
];

console.log('==== recycle/trash probes ====');
for (const p of probes) {
  try {
    const r = p.kind === 'get' ? await getJson(p.url) : await postJson(p.url, p.body);
    const hit = r.text.includes(needle) || r.text.includes('8月11');
    console.log(p.label, 'http', r.status, 'len', r.text.length, 'hit', hit, r.text.slice(0, 220));
  } catch (err) {
    console.log(p.label, 'err', String(err).slice(0, 200));
  }
}
