/**
 * Read metadata from the Youdao Note desktop client's local SQLite DB.
 *
 * Two capabilities:
 * 1. Cold-start seed: first run imports file metadata into sync_metadata.db
 * 2. domain=0 file local read (saves an HTTP download)
 *
 * Matches Python desktop_data.py.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { platform, env } from 'node:process';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import type { MetadataStore } from './metadata/store.js';
import type { DirId, FileId } from './types/common.js';
import { mapCloudName } from './scan/name.js';

export function findDesktopDataDir(): string | null {
  let base: string;
  if (platform === 'win32') {
    base = env['APPDATA'] ?? '';
  } else if (platform === 'darwin') {
    base = join(homedir(), 'Library', 'Application Support');
  } else {
    base = join(homedir(), '.config');
  }

  const ynoteDir = join(base, 'ynote-desktop');
  if (!existsSync(ynoteDir)) return null;

  for (const entry of readdirSync(ynoteDir)) {
    const dataDir = join(ynoteDir, entry, 'ynote-data');
    if (!existsSync(dataDir)) continue;
    const dbCandidates = readdirSync(dataDir).filter(
      (f) => f.endsWith('.db') && !f.endsWith('-content.db') && !f.endsWith('-search.db'),
    );
    if (dbCandidates.length > 0) return dataDir;
  }

  return null;
}

export function findDesktopDb(dataDir: string): string | null {
  if (!dataDir || !existsSync(dataDir)) return null;
  for (const f of readdirSync(dataDir)) {
    if (f.endsWith('.db') && !f.endsWith('-content.db') && !f.endsWith('-search.db')) {
      const path = join(dataDir, f);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

function buildPathMap(conn: Database.Database): Map<string, string> {
  const hasTable = conn.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='note_book'",
  ).get();
  if (!hasTable) return new Map();

  const rows = conn.prepare(
    "SELECT fileId, title, parentId FROM note_book WHERE del = 0 OR del IS NULL",
  ).all() as Array<{ fileId: string; title: string; parentId: string }>;

  const folders = new Map<string, { title: string; parentId: string }>();
  for (const row of rows) {
    folders.set(row.fileId, { title: row.title || '', parentId: row.parentId || '' });
  }

  const cache = new Map<string, string>();

  function resolve(fid: string, depth: number): string {
    if (cache.has(fid)) return cache.get(fid)!;
    if (depth > 50 || !folders.has(fid)) return '';
    const info = folders.get(fid)!;
    const pid = info.parentId;
    if (!pid || pid === fid) {
      cache.set(fid, '');
      return '';
    }
    const parentPath = resolve(pid, depth + 1);
    const path = parentPath ? `${parentPath}/${info.title}` : info.title;
    cache.set(fid, path);
    return path;
  }

  for (const fid of folders.keys()) {
    resolve(fid, 0);
  }

  return cache;
}

/**
 * Seed sync metadata from the desktop client's local DB (cold-start).
 * Returns the number of imported entries.
 */
export function seedMetadataFromDesktop(meta: MetadataStore, dataDir?: string): number {
  const dir = dataDir ?? findDesktopDataDir();
  if (!dir) return 0;

  const dbPath = findDesktopDb(dir);
  if (!dbPath) return 0;

  let conn: Database.Database;
  try {
    conn = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return 0;
  }

  try {
    const folderPaths = buildPathMap(conn);
    let count = 0;

    meta.batch(() => {
      for (const [fid, path] of folderPaths) {
        if (!path) continue;
        const row = conn.prepare(
          'SELECT parentId FROM note_book WHERE fileId = ?',
        ).get(fid) as { parentId: string } | undefined;
        const parentId = row?.parentId ?? '';
        meta.setDirInfo(path, fid as DirId, parentId as DirId);
        count++;
      }

      const noteRows = conn.prepare(
        "SELECT fileId, title, parentId, modifyTime, createTime, domain, version FROM note WHERE del = 0 AND dir = 0",
      ).all() as Array<{
        fileId: string; title: string; parentId: string;
        modifyTime: number; createTime: number; domain: number; version: number;
      }>;

      for (const row of noteRows) {
        const parentId = row.parentId || '';
        const folderPath = folderPaths.get(parentId) ?? '';
        const title = row.title || '';
        const localName = mapCloudName(title);
        const relPath = folderPath ? `${folderPath}/${localName}` : localName;

        let mtime = row.modifyTime || 0;
        if (mtime > 1_000_000_000_000) mtime = Math.floor(mtime / 1000);

        let ctime = row.createTime || 0;
        if (ctime > 1_000_000_000_000) ctime = Math.floor(ctime / 1000);

        meta.setFileInfo(relPath, {
          fileId: row.fileId as FileId,
          cloudMtime: mtime,
          localMtime: 0,
          parentId: parentId as DirId,
          domain: row.domain,
          createTime: ctime,
        });
        count++;
      }

      if (count > 0) {
        let maxVersion = 0;
        const vRow = conn.prepare(
          'SELECT MAX(version) as mv FROM note WHERE del = 0',
        ).get() as { mv: number | null } | undefined;
        if (vRow?.mv) maxVersion = vRow.mv;
        meta.setState('last_cloud_version', String(maxVersion));
      }
    });

    meta.save();
    return count;
  } catch {
    return 0;
  } finally {
    conn.close();
  }
}

/**
 * Read a domain=0 file from the desktop client's local cache.
 * The desktop client stores XML in file/<bucket>/<fileId>.
 */
export function readDesktopFile(fileId: FileId, dataDir?: string): Buffer | null {
  if (!fileId) return null;
  const dir = dataDir ?? findDesktopDataDir();
  if (!dir) return null;

  const bucket = fileId[0]!.toLowerCase();
  const path = join(dir, 'file', bucket, fileId);
  if (!existsSync(path)) return null;

  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
