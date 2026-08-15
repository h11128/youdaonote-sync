/**
 * List (default) or merge same-title diary `.md` + `.note` cloud pairs.
 *
 * Official Youdao app hides extensions, so the pair looks like two
 * "2026年M月D日" rows. App SOT is `.note`. Never deleteFile a diary `.note`.
 *
 * Usage (from ts-src):
 *   npx tsx scripts/merge-diary-md-note-pairs.mts
 *   npx tsx scripts/merge-diary-md-note-pairs.mts --apply
 *   npx tsx scripts/merge-diary-md-note-pairs.mts --apply 2026年8月13日
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { YoudaoNoteApi } from '../src/api/client.ts';
import { findFolderByPath, getDirectoryEntries } from '../src/browse/search.ts';

function stemToDate(stem: string): string {
  const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(stem);
  if (!m) throw new Error(`not a diary stem: ${stem}`);
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const only = argv.filter((a) => a !== '--apply');

const configDir = execSync('node dist/bin.js config path', { encoding: 'utf8' }).trim();
const api = new YoudaoNoteApi(join(configDir, 'cookies.json'));
const loginErr = api.loginByCookies();
if (loginErr) throw new Error(loginErr);

const diaryRoot = await findFolderByPath(api, '内在世界/日记');
if (!diaryRoot) throw new Error('cloud folder missing: 内在世界/日记');
const yearDirs = (await getDirectoryEntries(api, diaryRoot)).filter(
  (e) => e.isDir && /^\d{4}$/.test(e.name),
);
const byStem = new Map<string, { md?: string; note?: string }>();
for (const year of yearDirs) {
  const entries = await getDirectoryEntries(api, year.id);
  for (const e of entries) {
    const m = /^(.*年.*月.*日)\.(note|md)$/.exec(e.name);
    if (!m) continue;
    const rec = byStem.get(m[1]) ?? {};
    rec[m[2] as 'md' | 'note'] = e.id;
    byStem.set(m[1], rec);
  }
}
const pairs = [...byStem.entries()]
  .filter(([, r]) => r.md && r.note)
  .map(([stem]) => stem)
  .sort((a, b) => a.localeCompare(b, 'zh'));
const targets = only.length ? pairs.filter((s) => only.includes(s)) : pairs;
if (only.length && !targets.length) {
  throw new Error(`no md+note pair for: ${only.join(', ')}`);
}

console.log('PAIR_COUNT', pairs.length);
for (const stem of pairs) {
  const rec = byStem.get(stem);
  console.log(`${stem}\tmd=${rec?.md}\tnote=${rec?.note}`);
}

if (!apply) {
  if (pairs.length) {
    console.log(
      'Dry-run. --apply pushes local .md onto .note (overwrites cloud .note after backup) then deletes cloud .md.',
    );
  }
  process.exit(0);
}

for (const stem of targets) {
  const date = stemToDate(stem);
  console.log('APPLY', stem, date);
  execSync(`npx tsx scripts/restore-diary-notes-from-md.mts --force ${date}`, {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}
