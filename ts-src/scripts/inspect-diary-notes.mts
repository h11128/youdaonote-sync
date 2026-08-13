/**
 * Report listing size vs fetched bytes for diary `.note` / `.md` files.
 * Never deletes. Listing size=0 is normal and does not mean empty.
 *
 * Usage (from ts-src):
 *   npx tsx scripts/inspect-diary-notes.mts
 *   npx tsx scripts/inspect-diary-notes.mts 2026年8月7日
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { YoudaoNoteApi } from '../src/api/client.ts';
import { findFolderByPath, getDirectoryEntries } from '../src/browse/search.ts';
import { jsonBytesToMarkdown } from '../src/convert/json-to-md.ts';
import { asFileId } from '../src/types/common.ts';

const filter = new Set(process.argv.slice(2));
const configDir = execSync('node dist/bin.js config path', { encoding: 'utf8' }).trim();
const api = new YoudaoNoteApi(join(configDir, 'cookies.json'));
const loginErr = api.loginByCookies();
if (loginErr) throw new Error(loginErr);

const folderId = await findFolderByPath(api, '内在世界/日记/2026');
if (!folderId) throw new Error('cloud folder missing');
const entries = await getDirectoryEntries(api, folderId);
const targets = entries.filter((e) => {
  if (!/年.*月.*日\.(note|md)$/.test(e.name)) return false;
  if (filter.size === 0) return true;
  return [...filter].some((f) => e.name.startsWith(f) || e.name === f);
});

console.log('name\tlistingSize\tconvTrue\tconvFalse\tmdChars\tprefix\tnote');
for (const e of targets) {
  const conv = new Uint8Array(await api.getFileById(asFileId(e.id), { convert: true }));
  const raw = new Uint8Array(await api.getFileById(asFileId(e.id), { convert: false }));
  let mdChars = 0;
  const src = raw.length > 0 ? raw : conv;
  if (src.length > 0) {
    const prefix = Buffer.from(src.slice(0, 2)).toString('utf8');
    if (prefix.startsWith('{')) mdChars = jsonBytesToMarkdown(src).trim().length;
    else mdChars = Buffer.from(src).toString('utf8').trim().length;
  }
  const prefix = Buffer.from((raw.length > 0 ? raw : conv).slice(0, 24)).toString('utf8');
  const lie = e.size === 0 && (raw.length > 0 || conv.length > 0) ? 'LISTING_SIZE_LIE' : '';
  console.log(
    `${e.name}\t${e.size}\t${conv.length}\t${raw.length}\t${mdChars}\t${JSON.stringify(prefix)}\t${lie}`,
  );
}
