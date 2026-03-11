import type Database from 'better-sqlite3';
import { type RelPath, asRelPath } from '../types/common.js';

/**
 * file_base table (three-way merge). Single responsibility: file base content storage.
 */
export function saveBaseContent(
  db: Database.Database,
  path: RelPath,
  content: Buffer,
  hash: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'INSERT OR REPLACE INTO file_base (path, content, hash, saved_at) VALUES (?, ?, ?, ?)',
  ).run(path, content, hash, now);
}

export function getBaseContent(
  db: Database.Database,
  path: RelPath,
): { content: Buffer; hash: string } | null {
  const row = db.prepare('SELECT content, hash FROM file_base WHERE path = ?').get(path) as
    | { content: Buffer; hash: string }
    | undefined;
  if (!row) return null;
  return { content: Buffer.from(row.content), hash: row.hash };
}

export function removeBaseContent(db: Database.Database, path: RelPath): void {
  db.prepare('DELETE FROM file_base WHERE path = ?').run(path);
}

export function getAllBaseContentPaths(db: Database.Database): RelPath[] {
  const rows = db.prepare('SELECT path FROM file_base').all() as { path: string }[];
  return rows.map((r) => asRelPath(r.path));
}

// ========== file_refs (incremental ref caching for dedup) ==========

export function getFileRefs(db: Database.Database, sourcePath: RelPath): string[] {
  const rows = db
    .prepare('SELECT ref_path FROM file_refs WHERE source_path = ?')
    .all(sourcePath) as { ref_path: string }[];
  return rows.map((r) => r.ref_path);
}

export function setFileRefs(db: Database.Database, sourcePath: RelPath, refs: string[]): void {
  db.prepare('DELETE FROM file_refs WHERE source_path = ?').run(sourcePath);
  if (refs.length > 0) {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO file_refs (source_path, ref_path) VALUES (?, ?)',
    );
    for (const ref of refs) {
      insert.run(sourcePath, ref);
    }
  }
}

export function getAllFileRefs(db: Database.Database): Map<RelPath, string[]> {
  const rows = db.prepare('SELECT source_path, ref_path FROM file_refs').all() as {
    source_path: string;
    ref_path: string;
  }[];
  const result = new Map<RelPath, string[]>();
  for (const { source_path, ref_path } of rows) {
    const key = asRelPath(source_path);
    const list = result.get(key) ?? [];
    list.push(ref_path);
    result.set(key, list);
  }
  return result;
}
