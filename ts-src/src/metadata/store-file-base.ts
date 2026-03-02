import type Database from 'better-sqlite3';

/**
 * file_base table (three-way merge). Single responsibility: file base content storage.
 */
export function saveBaseContent(
  db: Database.Database,
  path: string,
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
  path: string,
): { content: Buffer; hash: string } | null {
  const row = db.prepare(
    'SELECT content, hash FROM file_base WHERE path = ?',
  ).get(path) as { content: Buffer; hash: string } | undefined;
  if (!row) return null;
  return { content: Buffer.from(row.content), hash: row.hash };
}

export function removeBaseContent(db: Database.Database, path: string): void {
  db.prepare('DELETE FROM file_base WHERE path = ?').run(path);
}

export function getAllBaseContentPaths(db: Database.Database): string[] {
  const rows = db.prepare('SELECT path FROM file_base').all() as Array<{ path: string }>;
  return rows.map((r) => r.path);
}
