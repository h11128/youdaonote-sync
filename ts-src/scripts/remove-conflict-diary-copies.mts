/**
 * List (default) or delete Youdao App copies named `(冲突笔记)年…月…日.md`.
 *
 * These are extra markdown rows next to the real diary. Never deleteFile a
 * diary `.note`. Always dump the copy under `.local-reports/` first.
 *
 * Usage (from ts-src):
 *   npx tsx scripts/remove-conflict-diary-copies.mts
 *   npx tsx scripts/remove-conflict-diary-copies.mts --apply
 *   npx tsx scripts/remove-conflict-diary-copies.mts --apply 2026年8月17日
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { YoudaoNoteApi } from '../src/api/client.ts';
import { findFolderByPath, getDirectoryEntries } from '../src/browse/search.ts';
import { jsonBytesToMarkdown } from '../src/convert/json-to-md.ts';
import { asFileId } from '../src/types/common.ts';

const CONFLICT_RE = /^\(冲突笔记\)(.+年.+月.+日)\.(md|note)$/;
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const only = argv.filter((a) => a !== '--apply');

const here = dirname(fileURLToPath(import.meta.url));
const dumpDir = join(here, '..', '..', '.local-reports');

const configDir = execSync('node dist/bin.js config path', { encoding: 'utf8' }).trim();
const api = new YoudaoNoteApi(join(configDir, 'cookies.json'));
const loginErr = api.loginByCookies();
if (loginErr) throw new Error(loginErr);

const diaryRoot = await findFolderByPath(api, '内在世界/日记');
if (!diaryRoot) throw new Error('cloud folder missing: 内在世界/日记');
const yearDirs = (await getDirectoryEntries(api, diaryRoot)).filter(
  (e) => e.isDir && /^\d{4}$/.test(e.name),
);

type Hit = { stem: string; ext: string; id: string; name: string; year: string };
const hits: Hit[] = [];
for (const year of yearDirs) {
  const entries = await getDirectoryEntries(api, year.id);
  for (const e of entries) {
    const m = CONFLICT_RE.exec(e.name);
    if (!m?.[1] || !m[2]) continue;
    hits.push({ stem: m[1], ext: m[2], id: e.id, name: e.name, year: year.name });
  }
}

const targets = only.length ? hits.filter((h) => only.includes(h.stem) || only.includes(h.name)) : hits;
if (only.length && !targets.length) {
  throw new Error(`no 冲突笔记 copy for: ${only.join(', ')}`);
}

console.log('CONFLICT_COUNT', hits.length);
for (const h of hits) {
  console.log(`${h.name}\tid=${h.id}\text=${h.ext}`);
}

function bytesToText(src: Uint8Array): string {
  if (src.length === 0) return '';
  const prefix = Buffer.from(src.slice(0, 2)).toString('utf8');
  return prefix.startsWith('{') ? jsonBytesToMarkdown(src) : Buffer.from(src).toString('utf8');
}

mkdirSync(dumpDir, { recursive: true });
const dumps: { hit: Hit; chars: number }[] = [];
for (const h of targets) {
  const raw = new Uint8Array(await api.getFileById(asFileId(h.id), { convert: false }));
  const conv = new Uint8Array(await api.getFileById(asFileId(h.id), { convert: true }));
  const rawText = bytesToText(raw);
  const convText = bytesToText(conv);
  const text = convText.trim().length > rawText.trim().length ? convText : rawText;
  const dumpPath = join(dumpDir, `${h.name}.dump.txt`);
  writeFileSync(dumpPath, text, 'utf8');
  dumps.push({ hit: h, chars: text.trim().length });
  console.log('DUMP', dumpPath, 'chars', text.trim().length);
}

if (!apply) {
  if (hits.length) {
    console.log('Dry-run. --apply deletes only `(冲突笔记)…日.md` (never `.note`).');
  }
  process.exit(0);
}

const noteHits = targets.filter((h) => h.ext === 'note');
if (noteHits.length) {
  throw new Error(`refuse deleteFile diary .note: ${noteHits.map((h) => h.name).join(', ')}`);
}
const emptyDumps = dumps.filter((d) => d.chars <= 0);
if (emptyDumps.length) {
  throw new Error(
    `refuse delete: empty dump for ${emptyDumps.map((d) => d.hit.name).join(', ')}`,
  );
}

for (const h of targets) {
  await api.deleteFile(asFileId(h.id));
  console.log('DELETED', h.name, h.id);
}
