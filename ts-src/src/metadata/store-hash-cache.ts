/**
 * Local file hash cache — avoids recomputing content hashes when mtime+size unchanged.
 *
 * Table: hash_cache(path TEXT PK, mtime INTEGER, size INTEGER, hash TEXT)
 *
 * Bump HASH_ALGO_VERSION when normalizeMdFormatting or hash algorithm changes.
 * On version mismatch the entire cache is invalidated.
 */
import type Database from 'better-sqlite3';
import type { ContentHash, EpochSeconds, RelPath } from '../types/common.js';
import { asContentHash } from '../types/common.js';

const HASH_ALGO_VERSION = 1;
const STATE_KEY = 'hash_cache_algo_version';

/**
 * Validate that the cached hashes were produced by the current algorithm.
 * Clears the cache if the version doesn't match.
 */
export function validateHashCacheVersion(db: Database.Database): void {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(STATE_KEY) as
    | { value: string }
    | undefined;
  const stored = row ? Number(row.value) : 0;
  if (stored !== HASH_ALGO_VERSION) {
    db.prepare('DELETE FROM hash_cache').run();
    db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)').run(
      STATE_KEY,
      String(HASH_ALGO_VERSION),
    );
  }
}

export function getCachedHash(
  db: Database.Database,
  path: string,
  mtime: EpochSeconds,
  size: number,
): ContentHash | null {
  const row = db
    .prepare('SELECT hash FROM hash_cache WHERE path = ? AND mtime = ? AND size = ?')
    .get(path, mtime, size) as { hash: string } | undefined;
  return row ? asContentHash(row.hash) : null;
}

export function setCachedHash(
  db: Database.Database,
  entry: { path: string; mtime: EpochSeconds; size: number; hash: ContentHash },
): void {
  db.prepare('INSERT OR REPLACE INTO hash_cache (path, mtime, size, hash) VALUES (?, ?, ?, ?)').run(
    entry.path,
    entry.mtime,
    entry.size,
    entry.hash,
  );
}

export function getCachedHashesBulk(
  db: Database.Database,
  entries: readonly { relPath: RelPath; mtime: EpochSeconds; size: number }[],
): Map<RelPath, ContentHash> {
  if (entries.length === 0) return new Map();

  const stmt = db.prepare('SELECT hash FROM hash_cache WHERE path = ? AND mtime = ? AND size = ?');
  const result = new Map<RelPath, ContentHash>();
  for (const { relPath, mtime, size } of entries) {
    const row = stmt.get(relPath, mtime, size) as { hash: string } | undefined;
    if (row) result.set(relPath, asContentHash(row.hash));
  }
  return result;
}

export function setCachedHashesBulk(
  db: Database.Database,
  entries: readonly { path: string; mtime: EpochSeconds; size: number; hash: ContentHash }[],
): void {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO hash_cache (path, mtime, size, hash) VALUES (?, ?, ?, ?)',
  );
  for (const { path, mtime, size, hash } of entries) {
    stmt.run(path, mtime, size, hash);
  }
}
