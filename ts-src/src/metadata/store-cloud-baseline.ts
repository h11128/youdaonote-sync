import type Database from 'better-sqlite3';
import type { EpochSeconds, RelPath } from '../types/common.js';

export function updateCloudMtime(db: Database.Database, path: RelPath, mtime: EpochSeconds): void {
  db.prepare('UPDATE files SET cloud_mtime = ? WHERE path = ?').run(mtime, path);
}

export function hasSyncedFiles(db: Database.Database): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM files WHERE last_sync_at > 0 LIMIT 1').get() as
    | { ok: number }
    | undefined;
  return row != null;
}
