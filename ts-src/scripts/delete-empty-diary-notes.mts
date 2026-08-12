/**
 * Delete 0-byte sibling .note files under 内在世界/日记/2026.
 * Usage (from ts-src):
 *   npx tsx scripts/delete-empty-diary-notes.mts 2026年8月11日 2026年8月10日 ...
 */
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { YoudaoNoteApi } from '../src/api/client.ts';
import { findFolderByPath, getDirectoryEntries } from '../src/browse/search.ts';
import { asFileId } from '../src/types/common.ts';

const names = process.argv.slice(2);
if (!names.length) {
  console.error('usage: delete-empty-diary-notes.mts <basename>...');
  process.exit(2);
}
const want = new Set(names.map((n) => (n.endsWith('.note') ? n : `${n}.note`)));
const configDir = execSync('node dist/bin.js config path', { encoding: 'utf8' }).trim();
const api = new YoudaoNoteApi(join(configDir, 'cookies.json'));
await api.loginByCookies();
const folderId = await findFolderByPath(api, '内在世界/日记/2026');
if (!folderId) throw new Error('folder missing');
const entries = await getDirectoryEntries(api, folderId);
let deleted = 0;
for (const e of entries) {
  if (!want.has(e.name)) continue;
  if (e.size !== 0) {
    console.log('skip non-empty', e.name, e.size);
    continue;
  }
  await api.deleteFile(asFileId(e.id));
  console.log('deleted', e.name, e.id);
  deleted += 1;
}
console.log(`done: deleted ${deleted}`);
