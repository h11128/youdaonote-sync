/**
 * Recreate Youdao-native diary `.note` files from local markdown.
 *
 * Why: the official Youdao app shows `.note`. Directory listings report
 * size=0 for those files even when they have content. Never treat listing
 * size as emptiness.
 *
 * Usage (from ts-src):
 *   npx tsx scripts/restore-diary-notes-from-md.mts 2026-08-07 2026-08-08
 *   npx tsx scripts/restore-diary-notes-from-md.mts --force 2026-08-11
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { YoudaoNoteApi } from '../src/api/client.ts';
import { findFolderByPath, getDirectoryEntries } from '../src/browse/search.ts';
import { jsonBytesToMarkdown } from '../src/convert/json-to-md.ts';
import { markdownToNoteJson } from '../src/convert/md-to-note.ts';
import { MetadataStore } from '../src/metadata/store.ts';
import { NoteDomain, asEpochSeconds, asFileId, asRelPath } from '../src/types/common.ts';
import { readFileMtime } from '../src/util/utils.ts';

function dateToDiaryBase(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`bad date ${date}; expected YYYY-MM-DD`);
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

function configDir(): string {
  return execSync('node dist/bin.js config path', { encoding: 'utf8' }).trim();
}

function localNotesRoot(): string {
  const cfg = JSON.parse(readFileSync(join(configDir(), 'config.json'), 'utf8')) as {
    local_dir?: string;
  };
  if (!cfg.local_dir) throw new Error('config.json missing local_dir');
  return cfg.local_dir;
}

function nonEmptyMarkdown(body: string, label: string): void {
  const back = jsonBytesToMarkdown(Buffer.from(body, 'utf8'));
  if (!back.trim()) {
    throw new Error(`REFUSE: ${label} converted to empty markdown; not uploading`);
  }
}

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const dates = argv.filter((a) => a !== '--force');
if (!dates.length) {
  console.error('usage: restore-diary-notes-from-md.mts [--force] YYYY-MM-DD [...]');
  process.exit(2);
}

const api = new YoudaoNoteApi(join(configDir(), 'cookies.json'));
const loginErr = api.loginByCookies();
if (loginErr) throw new Error(loginErr);

const notesRoot = localNotesRoot();
const meta = new MetadataStore(join(configDir(), 'sync_metadata.db'));

for (const date of dates) {
  const year = date.slice(0, 4);
  const folderPath = `内在世界/日记/${year}`;
  const folderId = await findFolderByPath(api, folderPath);
  if (!folderId) throw new Error(`cloud folder missing: ${folderPath}`);
  const entries = await getDirectoryEntries(api, folderId);
  const base = dateToDiaryBase(date);
  const mdPath = join(notesRoot, '内在世界', '日记', year, `${base}.md`);
  if (!existsSync(mdPath)) throw new Error(`local missing: ${mdPath}`);
  const md = readFileSync(mdPath, 'utf8');
  if (!md.trim()) throw new Error(`REFUSE: local markdown empty: ${mdPath}`);

  const body = markdownToNoteJson(md);
  nonEmptyMarkdown(body, `${base} local→note`);

  const noteEnt = entries.find((e) => e.name === `${base}.note`);
  const mdEnt = entries.find((e) => e.name === `${base}.md`);

  if (noteEnt) {
    const raw = new Uint8Array(
      await api.getFileById(asFileId(noteEnt.id), { convert: false }),
    );
    if (raw.length > 0 && !force) {
      console.log('skip existing non-empty .note', base, raw.length);
    } else {
      if (force && raw.length > 0) {
        const bakDir = join(notesRoot, '.local-reports', 'diary-backups');
        mkdirSync(bakDir, { recursive: true });
        const bak = join(bakDir, `${base}.note.pre-force-${Date.now()}`);
        writeFileSync(bak, raw);
        console.log('backed up cloud .note before --force', bak, raw.length);
      }
      await api.pushFile({
        fileId: asFileId(noteEnt.id),
        parentId: folderId,
        name: `${base}.note`,
        domain: NoteDomain.NOTE,
        bodyString: body,
        isCreate: false,
      });
      console.log(raw.length > 0 ? 'updated .note --force' : 'updated empty .note', base);
    }
  } else {
    const fileId = YoudaoNoteApi.generateFileId();
    await api.pushFile({
      fileId,
      parentId: folderId,
      name: `${base}.note`,
      domain: NoteDomain.NOTE,
      bodyString: body,
      isCreate: true,
    });
    console.log('created .note', base, fileId);
  }

  const after = await getDirectoryEntries(api, folderId);
  const created = after.find((e) => e.name === `${base}.note`);
  if (!created) throw new Error(`verify failed: ${base}.note missing after restore`);
  const verify = new Uint8Array(
    await api.getFileById(asFileId(created.id), { convert: false }),
  );
  if (verify.length === 0) throw new Error(`verify failed: ${base}.note fetch is 0 bytes`);

  const leftoverMd = after.find((e) => e.name === `${base}.md`) ?? mdEnt;
  if (leftoverMd) {
    // Official app hides extensions: leftover `.md` shows as a second same-title diary.
    // Never deleteFile the `.note`. The `.md` sibling is the duplicate.
    await api.deleteFile(asFileId(leftoverMd.id));
    console.log('deleted leftover cloud .md', base, leftoverMd.id);
  }

  const rel = asRelPath(`内在世界/日记/${date.slice(0, 4)}/${base}.md`);
  const prev = meta.getFileInfo(rel);
  meta.setFileInfo(rel, {
    fileId: asFileId(created.id),
    cloudMtime: asEpochSeconds(created.modifyTime || Math.floor(Date.now() / 1000)),
    localMtime: asEpochSeconds(readFileMtime(mdPath)),
    parentId: folderId,
    domain: NoteDomain.NOTE,
    contentHash: prev?.contentHash ?? null,
    lastSyncAt: asEpochSeconds(Math.floor(Date.now() / 1000)),
  });
  meta.markSynced(rel);
  console.log('verified', base, 'rawBytes', verify.length, 'meta←', created.id);
}
meta.close();
