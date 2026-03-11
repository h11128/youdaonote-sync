import type Database from 'better-sqlite3';
import { asRelPath, type DirId, type RelPath } from '../types/common.js';

/**
 * Directory table operations. Paths must be normalized (e.g. forward slashes) by caller.
 * Used by MetadataStore to keep store.ts under ~300 lines.
 */
export function getDirId(db: Database.Database, path: RelPath): DirId | null {
  const row = db.prepare('SELECT dir_id FROM directories WHERE path = ?').get(path) as
    | { dir_id: string }
    | undefined;
  return (row?.dir_id ?? null) as DirId | null;
}

export function setDirInfo(
  db: Database.Database,
  path: RelPath,
  dirId: DirId,
  parentId?: DirId | null,
): void {
  db.prepare('INSERT OR REPLACE INTO directories (path, dir_id, parent_id) VALUES (?, ?, ?)').run(
    path,
    dirId || '',
    parentId ?? '',
  );
}

export function removeDir(db: Database.Database, path: RelPath): void {
  db.prepare('DELETE FROM directories WHERE path = ?').run(path);
}

export function getAllDirs(
  db: Database.Database,
): Map<RelPath, { dirId: DirId; parentId: DirId | null }> {
  const rows = db.prepare('SELECT path, dir_id, parent_id FROM directories').all() as {
    path: string;
    dir_id: string;
    parent_id: string | null;
  }[];
  const result = new Map<RelPath, { dirId: DirId; parentId: DirId | null }>();
  for (const row of rows) {
    result.set(asRelPath(row.path), {
      dirId: row.dir_id as DirId,
      parentId: row.parent_id != null ? (row.parent_id as DirId) : null,
    });
  }
  return result;
}

export function getAllDirPaths(db: Database.Database): RelPath[] {
  const rows = db.prepare('SELECT path FROM directories').all() as { path: string }[];
  return rows.map((r) => asRelPath(r.path));
}

export function findByDirId(db: Database.Database, dirId: DirId): RelPath | null {
  const row = db.prepare('SELECT path FROM directories WHERE dir_id = ?').get(dirId) as
    | { path: string }
    | undefined;
  return row ? asRelPath(row.path) : null;
}
